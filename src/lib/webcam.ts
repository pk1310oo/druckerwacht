/**
 * Webcam am Computer: ein gemeinsamer Videostrom für alle Ansichten (die Kamera wird nur
 * einmal geöffnet) und Standbilder als JPEG für den Zeitraffer.
 */
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useStore } from "./store";
import { isTauri } from "./api";

let stream: MediaStream | null = null;
let streamDevice = "";
let opening: Promise<MediaStream> | null = null;
let users = 0;

async function open(deviceId: string): Promise<MediaStream> {
  if (stream && streamDevice === deviceId && stream.active) return stream;
  if (!navigator.mediaDevices?.getUserMedia) throw Object.assign(new Error("no mediaDevices"), { name: "Unsupported" });
  if (opening) return opening;
  stop();
  opening = navigator.mediaDevices
    .getUserMedia({
      audio: false,
      video: {
        ...(deviceId && deviceId !== "default" ? { deviceId: { exact: deviceId } } : {}),
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
    })
    .then((s) => {
      stream = s;
      streamDevice = deviceId;
      return s;
    })
    .finally(() => {
      opening = null;
    });
  return opening;
}

function stop() {
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
}

/** Strom anfordern; mit `release()` wieder freigeben. Die Kamera geht aus, wenn niemand sie braucht. */
export async function acquire(deviceId: string) {
  users++;
  try {
    return await open(deviceId);
  } catch (e) {
    users--;
    throw e;
  }
}

export function release() {
  users = Math.max(0, users - 1);
  // kurz nachlaufen lassen: beim Druckende wird noch ein letztes Foto geschossen
  if (users === 0) setTimeout(() => users === 0 && stop(), 6000);
}

export interface Webcam {
  deviceId: string;
  label: string;
}

/** Alle Webcams. Die Namen gibt der Browser erst nach einer Kamerafreigabe heraus. */
export async function listWebcams(askPermission: boolean): Promise<Webcam[]> {
  if (!navigator.mediaDevices?.enumerateDevices) throw Object.assign(new Error("no mediaDevices"), { name: "Unsupported" });
  if (askPermission) {
    const s = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    s.getTracks().forEach((t) => t.stop());
  }
  const all = await navigator.mediaDevices.enumerateDevices();
  return all
    .filter((d) => d.kind === "videoinput")
    .map((d, i) => ({ deviceId: d.deviceId || "default", label: d.label || `Webcam ${i + 1}` }));
}

/** Aktuelles Bild als JPEG (base64 ohne Präfix). */
export async function grabJpeg(s: MediaStream, quality = 0.85): Promise<string | null> {
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.srcObject = s;
  try {
    await video.play();
    if (!video.videoWidth) await new Promise((r) => video.addEventListener("loadeddata", r, { once: true }));
    const c = document.createElement("canvas");
    c.width = video.videoWidth;
    c.height = video.videoHeight;
    c.getContext("2d")!.drawImage(video, 0, 0);
    const url = c.toDataURL("image/jpeg", quality);
    return url.split(",")[1] ?? null;
  } catch {
    return null;
  } finally {
    video.pause();
    video.srcObject = null;
  }
}

/** Woher kommt das Kamerabild? Webcam am Computer hat Vorrang vor einer Stream-Adresse. */
export type CameraSource = { kind: "local"; deviceId: string } | { kind: "url"; url: string } | null;

export function useCameraSource(): CameraSource {
  const local = useStore((s) => s.settings.localCamera.trim());
  const url = useStore((s) => s.settings.cameraUrl.trim());
  if (local) return { kind: "local", deviceId: local };
  if (url) return { kind: "url", url };
  return null;
}

/** Videostrom der Webcam für eine Ansicht (öffnet beim Einblenden, schließt beim Ausblenden). */
export function useWebcamStream(deviceId: string | null) {
  const [s, setS] = useState<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    if (!deviceId) return;
    let alive = true;
    setError(null);
    acquire(deviceId)
      .then((st) => alive && setS(st))
      .catch((e: Error) => alive && setError(e?.name || "Error"));
    return () => {
      alive = false;
      setS(null);
      release();
    };
  }, [deviceId, nonce]);
  return { stream: s, error, retry: () => setNonce((n) => n + 1) };
}

/**
 * Webcam während des Drucks: Die Kamera bleibt bei Druck und Pause offen. Pro neuer Schicht geht
 * ein Bild ans Backend (neuestes Foto für Handy-Nachrichten, bei eingeschaltetem Zeitraffer auch
 * als Zeitraffer-Bild). Bei Pause, Druckende oder Fehler wird sofort ein frisches Foto geschickt.
 */
export function useWebcamTimelapse() {
  const local = useStore((s) => s.settings.localCamera.trim());
  const state = useStore((s) => s.status?.state ?? null);
  const preparing = useStore((s) => s.status?.preparing ?? false);
  const layer = useStore((s) => s.status?.layer ?? null);
  const cam = useRef<MediaStream | null>(null);
  const lastCam = useRef<MediaStream | null>(null);
  const prevState = useRef(state);
  const running = state === "printing" || state === "paused";
  const active = isTauri && !!local && running;

  useEffect(() => {
    if (!active) return;
    let alive = true;
    acquire(local)
      .then((s) => {
        if (alive) cam.current = lastCam.current = s;
        else release();
      })
      .catch(() => {});
    return () => {
      alive = false;
      if (cam.current) {
        cam.current = null;
        release();
      }
    };
  }, [active, local]);

  // Pro neuer Schicht ein Bild
  useEffect(() => {
    const s = cam.current;
    if (!active || preparing || state !== "printing" || !s || layer == null || layer <= 0) return;
    void grabJpeg(s).then((data) => {
      if (data) invoke("timelapse_add_frame", { layer, data }).catch(() => {});
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, layer]);

  // Zustandswechsel (Pause, fertig, Fehler, abgebrochen): sofort ein frisches Foto fürs Handy
  useEffect(() => {
    const was = prevState.current;
    prevState.current = state;
    if (!isTauri || !local || was !== "printing" || state === "printing" || state == null) return;
    const s = lastCam.current;
    if (!s?.active) return;
    void grabJpeg(s).then((data) => {
      if (data) invoke("camera_snapshot", { data }).catch(() => {});
    });
  }, [state, local]);
}
