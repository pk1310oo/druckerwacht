import { t } from "../lib/i18n";
import { useEffect, useRef, useState } from "react";
import { RefreshCw, VideoOff } from "lucide-react";
import { EmptyState } from "./ui";
import { useWebcamStream, type CameraSource } from "../lib/webcam";

/**
 * Zeigt einen MJPEG-Stream oder ein Einzelbild (z. B. Nebula-Kamera
 * http://<ip>:8080/?action=stream). Fehler werden freundlich abgefangen.
 */
export function CameraFrame({ url }: { url: string }) {
  const [phase, setPhase] = useState<"loading" | "ok" | "error">("loading");
  const [nonce, setNonce] = useState(0);

  useEffect(() => setPhase("loading"), [url, nonce]);

  // Ohne Antwort nach 10 s gilt die Kamera als nicht erreichbar.
  useEffect(() => {
    if (phase !== "loading") return;
    const t = setTimeout(() => setPhase("error"), 10_000);
    return () => clearTimeout(t);
  }, [phase]);

  const src = url + (nonce ? (url.includes("?") ? "&" : "?") + `_r=${nonce}` : "");

  return (
    <div className="camera-frame">
      {phase !== "error" && (
        <img
          key={src}
          src={src}
          alt={t("Kamerabild")}
          style={{ opacity: phase === "ok" ? 1 : 0 }}
          onLoad={() => setPhase("ok")}
          onError={() => setPhase("error")}
        />
      )}
      {phase === "loading" && <div className="skeleton" style={{ position: "absolute", inset: 0, borderRadius: 0 }} />}
      {phase === "error" && (
        <EmptyState
          icon={VideoOff}
          title={t("Kamera nicht erreichbar")}
          text={t("Prüfe die Stream-Adresse in den Einstellungen.")}
          actions={
            <button className="btn sm" onClick={() => setNonce((n) => n + 1)}>
              <RefreshCw size={14} /> {t("Erneut versuchen")}
            </button>
          }
        />
      )}
    </div>
  );
}

/** Kamerabild aus der eingestellten Quelle: Webcam am Computer oder Stream-Adresse. */
export function CameraBox({ source }: { source: NonNullable<CameraSource> }) {
  return source.kind === "local" ? <WebcamFrame deviceId={source.deviceId} /> : <CameraFrame url={source.url} />;
}

/** Live-Bild der Webcam am Computer. */
export function WebcamFrame({ deviceId }: { deviceId: string }) {
  const { stream, error, retry } = useWebcamStream(deviceId);
  const video = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (video.current) video.current.srcObject = stream;
  }, [stream]);
  if (error) {
    const denied = error === "NotAllowedError" || error === "SecurityError";
    const unsupported = error === "Unsupported";
    return (
      <div className="camera-frame">
        <EmptyState
          icon={VideoOff}
          title={unsupported ? t("Webcam-Zugriff nicht verfügbar") : denied ? t("Kamerazugriff nicht erlaubt") : t("Webcam nicht gefunden")}
          text={
            unsupported
              ? t("Diese Version kann hier nicht auf Webcams zugreifen. Bitte Druckerwacht einmal neu starten.")
              : denied
              ? t("Erlaube Druckerwacht den Zugriff auf die Kamera (Mac: Systemeinstellungen → Datenschutz & Sicherheit → Kamera).")
              : t("Ist die Webcam eingesteckt? Sonst in den Einstellungen eine andere Webcam wählen.")
          }
          actions={
            <button className="btn sm" onClick={retry}>
              <RefreshCw size={14} /> {t("Erneut versuchen")}
            </button>
          }
        />
      </div>
    );
  }
  return (
    <div className="camera-frame">
      <video ref={video} autoPlay muted playsInline style={{ opacity: stream ? 1 : 0 }} />
      {!stream && <div className="skeleton" style={{ position: "absolute", inset: 0, borderRadius: 0 }} />}
    </div>
  );
}
