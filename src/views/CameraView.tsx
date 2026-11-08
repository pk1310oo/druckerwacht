import { VideoOff } from "lucide-react";
import { Card, EmptyState } from "../components/ui";
import { CameraBox } from "../components/Camera";
import { useCameraSource } from "../lib/webcam";
import type { ViewId } from "../components/Shell";
import { t } from "../lib/i18n";

export function CameraView({ go }: { go: (v: ViewId) => void }) {
  const camera = useCameraSource();
  return (
    <div className="view camera-view">
      <Card className="camera">
        <div className="chart-head">
          <span className="label">{t("Kamera")}</span>
          {camera && (
            <span className="live">
              <i /> Live
            </span>
          )}
        </div>
        {camera ? (
          <CameraBox source={camera} />
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
