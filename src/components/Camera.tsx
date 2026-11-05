import { t } from "../lib/i18n";
import { useEffect, useState } from "react";
import { RefreshCw, VideoOff } from "lucide-react";
import { EmptyState } from "./ui";

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
              <RefreshCw size={14} /> Erneut versuchen
            </button>
          }
        />
      )}
    </div>
  );
}
