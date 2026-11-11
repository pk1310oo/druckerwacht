import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "./api";

export const APP_VERSION = __APP_VERSION__;
export const KOFI_URL = "https://ko-fi.com/prisma76863";
export const REPO_URL = "https://github.com/pk1310oo/druckerwacht";

export interface UpdateInfo {
  latest: string;
  newer: boolean;
  url: string;
}

/** Vergleicht „1.2.3“-Versionen; positiv, wenn a neuer ist. */
export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, "").split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = b.replace(/^v/, "").split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/**
 * Fragt die neueste Version bei GitHub ab. Es werden keine Daten gesendet außer der
 * normalen Anfrage; schlägt sie fehl (offline, Repo privat …), gibt es einfach kein Ergebnis.
 */
export async function checkForUpdate(): Promise<UpdateInfo | null> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch("https://api.github.com/repos/pk1310oo/druckerwacht/releases/latest", {
      headers: { Accept: "application/vnd.github+json" },
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (!res.ok) return null;
    const data = (await res.json()) as { tag_name?: string; html_url?: string };
    if (!data.tag_name) return null;
    const latest = data.tag_name.replace(/^v/, "");
    return { latest, newer: compareVersions(latest, APP_VERSION) > 0, url: `${REPO_URL}/releases/latest` };
  } catch {
    return null;
  }
}

/** Öffnet eine Seite des Projekts im Browser. */
export async function openProjectLink(url: string) {
  if (!isTauri) {
    window.open(url, "_blank", "noopener");
    return;
  }
  await invoke("open_project_link", { url });
}
