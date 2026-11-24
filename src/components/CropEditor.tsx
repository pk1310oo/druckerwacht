/**
 * Bildausschnitt für den KI-Wächter: Kamerabild anzeigen, mit der Maus einen Rahmen um das
 * Druckbett ziehen. Werte relativ (0–1): [x, y, Breite, Höhe].
 */
import { useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Crop, Loader2, Maximize2 } from "lucide-react";
import { isTauri } from "../lib/api";
import { acquire, grabJpeg, release } from "../lib/webcam";
import { t } from "../lib/i18n";

export type CropBox = [number, number, number, number];

async function cameraImage(localCamera: string): Promise<string | null> {
  // Nur Browser-Vorschau: Testbild von außen
  if (!isTauri) return (window as unknown as { __dwCamImage?: string }).__dwCamImage ?? null;
  if (localCamera) {
    try {
      const s = await acquire(localCamera);
      const b64 = await grabJpeg(s);
      return b64 ? `data:image/jpeg;base64,${b64}` : null;
    } catch {
      return null;
    } finally {
      release();
    }
  }
  const b64 = await invoke<string | null>("ai_camera_image");
  return b64 ? `data:image/jpeg;base64,${b64}` : null;
}

export function CropEditor({ value, localCamera, onChange }: { value: CropBox | null; localCamera: string; onChange: (v: CropBox | null) => void }) {
  const [img, setImg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [missing, setMissing] = useState(false);
  const [draft, setDraft] = useState<CropBox | null>(value);
  const box = useRef<HTMLDivElement>(null);
  const start = useRef<[number, number] | null>(null);

  const load = async () => {
    setBusy(true);
    setMissing(false);
    const src = await cameraImage(localCamera);
    setBusy(false);
    setDraft(value);
    if (src) setImg(src);
    else setMissing(true);
  };
  const rel = (e: React.PointerEvent): [number, number] => {
    const r = box.current!.getBoundingClientRect();
    return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))];
  };

  if (!img) {
    return (
      <div className="crop-start">
        <button className="btn sm" disabled={busy} onClick={() => void load()}>
          {busy ? <Loader2 size={14} className="spin" /> : <Crop size={14} />} {value ? t("Bildausschnitt ändern") : t("Bildausschnitt festlegen")}
        </button>
        {value && (
          <button className="btn sm ghost" onClick={() => onChange(null)}>
            <Maximize2 size={14} /> {t("Ganzes Bild")}
          </button>
        )}
        {missing && <span className="hint error">{t("Gerade kein Kamerabild – ist die Kamera eingerichtet und angeschlossen?")}</span>}
      </div>
    );
  }
  return (
    <div className="crop-editor">
      <span className="hint">{t("Ziehe mit der Maus einen Rahmen um das Druckbett. Nur dieser Teil wird geprüft – Möbel und Hintergrund stören dann nicht mehr.")}</span>
      <div
        ref={box}
        className="crop-stage"
        onPointerDown={(e) => {
          (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
          start.current = rel(e);
          setDraft(null);
        }}
        onPointerMove={(e) => {
          if (!start.current) return;
          const [x0, y0] = start.current;
          const [x1, y1] = rel(e);
          setDraft([Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0)]);
        }}
        onPointerUp={() => (start.current = null)}
      >
        <img src={img} alt={t("Kamerabild")} draggable={false} />
        {draft && (
          <div className="crop-rect" style={{ left: `${draft[0] * 100}%`, top: `${draft[1] * 100}%`, width: `${draft[2] * 100}%`, height: `${draft[3] * 100}%` }} />
        )}
      </div>
      <div className="crop-actions">
        <button className="btn sm ghost" onClick={() => setImg(null)}>
          {t("Abbrechen")}
        </button>
        <button className="btn sm ghost" onClick={() => setDraft(null)}>
          {t("Ganzes Bild")}
        </button>
        <button
          className="btn sm primary"
          disabled={!!draft && (draft[2] < 0.05 || draft[3] < 0.05)}
          onClick={() => {
            onChange(draft && draft[2] >= 0.05 && draft[3] >= 0.05 ? (draft.map((v) => Math.round(v * 1000) / 1000) as CropBox) : null);
            setImg(null);
          }}
        >
          {t("Übernehmen")}
        </button>
      </div>
    </div>
  );
}
