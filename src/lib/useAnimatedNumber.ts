import { useEffect, useRef, useState } from "react";

const reduceMotion =
  typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/** Lässt Zahlen weich zum neuen Wert gleiten statt zu springen. */
export function useAnimatedNumber(target: number | null | undefined, duration = 450): number | null {
  const [value, setValue] = useState<number | null>(target ?? null);
  const fromRef = useRef<number | null>(target ?? null);
  const frame = useRef(0);

  useEffect(() => {
    if (target == null || !Number.isFinite(target)) {
      fromRef.current = null;
      setValue(null);
      return;
    }
    const from = fromRef.current;
    if (from == null || reduceMotion || Math.abs(from - target) < 1e-6) {
      fromRef.current = target;
      setValue(target);
      return;
    }
    const start = performance.now();
    const step = (now: number) => {
      const p = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - p, 3);
      const v = from + (target - from) * eased;
      fromRef.current = v;
      setValue(v);
      if (p < 1) frame.current = requestAnimationFrame(step);
    };
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame.current);
  }, [target, duration]);

  return value;
}
