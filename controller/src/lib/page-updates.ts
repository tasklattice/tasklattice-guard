import { useLayoutEffect } from "react";

const blockers = new Set<symbol>();
const reloadKey = "tali.ui.lastAutomaticReload";
const reloadCooldown = 60_000;

/** Full-page editors use their own dirty state; drawers are protected in SheetContent. */
export function usePageUpdateBlocker(blocked: boolean) {
  useLayoutEffect(() => {
    if (!blocked) return;
    const token = Symbol();
    blockers.add(token);
    return () => { blockers.delete(token); };
  }, [blocked]);
}

export function pageUpdateBlocked() {
  return blockers.size > 0
    || Boolean(document.querySelector('[data-page-update-blocked="true"], form'))
    || Boolean(document.activeElement?.matches('input, textarea, [contenteditable="true"]'));
}

/** Reload the document, not just query data: an open SPA still executes its old bundle. */
export function startPageUpdates({
  buildId = document.querySelector<HTMLMetaElement>('meta[name="tali-ui-build"]')?.content,
  isBusy = () => false,
  reload = () => window.location.reload(),
  fetchVersion = async () => {
    const response = await fetch("/ui-version.json", { cache: "no-store", signal: AbortSignal.timeout(5_000) });
    if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) return null;
    const value: unknown = await response.json();
    return value && typeof value === "object" && "buildId" in value
      && typeof value.buildId === "string" && /^[a-f0-9-]{36}$/.test(value.buildId) ? value.buildId : null;
  },
}: {
  buildId?: string;
  isBusy?: () => boolean;
  reload?: () => void;
  fetchVersion?: () => Promise<string | null>;
} = {}) {
  // Vite development uses HMR and deliberately has no production build marker.
  if (!buildId) return () => {};
  let stopped = false;
  let inFlight = false;
  let pending: string | null = null;
  let reloading = false;
  let lastAttempt = 0;
  try { lastAttempt = Number(sessionStorage.getItem(reloadKey)) || 0; } catch { /* Storage can be disabled. */ }

  const tryReload = () => {
    if (stopped || reloading || !pending || document.visibilityState === "hidden" || isBusy() || pageUpdateBlocked()) return;
    // During a rolling deployment requests can reach different replicas.
    // Bound reloads across documents rather than creating a refresh loop.
    if (Date.now() - lastAttempt < reloadCooldown) return;
    reloading = true;
    lastAttempt = Date.now();
    try { sessionStorage.setItem(reloadKey, String(lastAttempt)); } catch { /* Reload still works without storage. */ }
    reload();
  };
  const check = async () => {
    if (stopped || reloading || inFlight || document.visibilityState === "hidden") return;
    inFlight = true;
    try {
      const current = await fetchVersion();
      if (stopped) return;
      // Network/HTTP/JSON failures are not evidence of a deployment.
      pending = current && current !== buildId ? current : null;
      tryReload();
    } catch { pending = null; /* Keep the current page during temporary deployment/network outages. */ }
    finally { inFlight = false; }
  };
  const wake = () => { void check(); };
  const poll = window.setInterval(wake, 15_000);
  // Once an editor is saved/closed, apply an already detected update promptly.
  const resume = window.setInterval(tryReload, 1_000);
  window.addEventListener("focus", wake);
  window.addEventListener("online", wake);
  window.addEventListener("pageshow", wake);
  document.addEventListener("visibilitychange", wake);
  // A missing old lazy chunk is another signal to check the deployment.
  // Do not suppress genuine import errors when the build has not changed.
  window.addEventListener("vite:preloadError", wake);
  wake();
  return () => {
    stopped = true;
    clearInterval(poll);
    clearInterval(resume);
    window.removeEventListener("focus", wake);
    window.removeEventListener("online", wake);
    window.removeEventListener("pageshow", wake);
    document.removeEventListener("visibilitychange", wake);
    window.removeEventListener("vite:preloadError", wake);
  };
}
