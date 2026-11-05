import { VideoOff } from "lucide-react";
import { useStore } from "../lib/store";
import { Card, EmptyState } from "../components/ui";
import { CameraFrame } from "../components/Camera";
import type { ViewId } from "../components/Shell";
import { t } from "../lib/i18n";

export function CameraView({ go }: { go: (v: ViewId) => void }) {
  const url = useStore((s) => s.settings.cameraUrl.trim());
  return (
    <div className="view camera-view">
      <Card className="camera">
        <div className="chart-head">
          <span className="label">{t("Kamera")}</span>
          {url && (
            <span className="live">
              <i /> Live
            </span>
          )}
        </div>
        {url ? (
          <CameraFrame url={url} />
        ) : (
          <EmptyState
            icon={VideoOff}
            title={t("Keine Kamera eingerichtet")}
            text={t("Trage in den Einstellungen die Stream-Adresse deiner Kamera ein.")}
            actions={
              <button className="btn" onClick={() => go("settings")}>
                {t("Zu den Einstellungen")}
              </button>
            }
          />
        )}
      </Card>
    </div>
  );
}
