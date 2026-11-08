import { useMemo } from "react";
import qrcode from "qrcode-generator";

/** QR-Code als SVG (schwarz auf weiß, damit jede Handykamera ihn sicher liest) */
export function Qr({ text, size = 168 }: { text: string; size?: number }) {
  const { n, path } = useMemo(() => {
    const q = qrcode(0, "M");
    q.addData(text);
    q.make();
    const n = q.getModuleCount();
    let d = "";
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (q.isDark(y, x)) d += `M${x} ${y}h1v1h-1z`;
    return { n, path: d };
  }, [text]);
  const m = 2; // Ruhezone
  return (
    <svg className="qr" width={size} height={size} viewBox={`${-m} ${-m} ${n + 2 * m} ${n + 2 * m}`} role="img" aria-label="QR-Code" shapeRendering="crispEdges">
      <rect x={-m} y={-m} width={n + 2 * m} height={n + 2 * m} fill="#fff" rx={1.5} />
      <path d={path} fill="#111" />
    </svg>
  );
}
