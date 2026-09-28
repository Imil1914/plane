/**
 * UX1.1 design switch («гибрид A+B») for TSX. CSS switches on <html data-ppm-design / data-ppm-density>, which
 * root.tsx sets before first paint; TSX reads the same attribute, so markup and styles never disagree (also with
 * PPM_DESIGN_V2=preview + a per-browser opt-in). Density is device-local (R3): localStorage only, no profile write.
 */
import { useState, useSyncExternalStore } from "react";
import { getPpmTranslation, PPM_DENSITY_STORAGE_KEY, resolvePpmDensity, resolvePpmDesign } from "@ppm/brand";
import type { TPpmDensity, TPpmTranslationKey } from "@ppm/brand";

export const PPM_DENSITY_CHANGE_EVENT = "ppm:density-change";

const getRoot = (): HTMLElement | null => (typeof document === "undefined" ? null : document.documentElement);

/** v2 look is on for this page load: the attribute written by the pre-paint script, else the build flags. */
export function isPpmDesignV2(): boolean {
  const attribute = getRoot()?.dataset.ppmDesign;
  if (attribute === "v1" || attribute === "v2") return attribute === "v2";
  return resolvePpmDesign(process.env.PPM_DESIGN_V2, process.env.PPM_BRAND_ENABLED, null) === "v2";
}

/** Same value for the whole page load (the attribute is set once, before first paint); rollback needs a reload. */
export function usePpmDesignV2(): boolean {
  const [isV2] = useState(isPpmDesignV2);
  return isV2;
}

export function getPpmDensity(): TPpmDensity {
  return resolvePpmDensity(getRoot()?.dataset.ppmDensity ?? null);
}

/** Applies instantly (CSS tokens follow the attribute) and remembers the choice in this browser only. */
export function setPpmDensity(density: TPpmDensity): void {
  const next = resolvePpmDensity(density);
  const root = getRoot();
  if (root) root.dataset.ppmDensity = next;
  try {
    localStorage.setItem(PPM_DENSITY_STORAGE_KEY, next);
  } catch {
    // Private mode or blocked storage: the attribute still applies to this page load.
  }
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(PPM_DENSITY_CHANGE_EVENT, { detail: next }));
}

function subscribeToDensity(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(PPM_DENSITY_CHANGE_EVENT, onChange);
  return () => window.removeEventListener(PPM_DENSITY_CHANGE_EVENT, onChange);
}

export function usePpmDensity(): TPpmDensity {
  return useSyncExternalStore(subscribeToDensity, getPpmDensity, (): TPpmDensity => "comfortable");
}

// ---------------- UX1.1 R11: Russian names for Plane's exact default states (display only) ----------------

/** Default states created by the API (apps/api/plane/db/models/state.py:24-62): group → stored name + display key. */
const PPM_DEFAULT_STATES: Record<string, { name: string; key: TPpmTranslationKey }> = {
  backlog: { name: "Backlog", key: "ux.state.backlog" },
  unstarted: { name: "Todo", key: "ux.state.unstarted" },
  started: { name: "In Progress", key: "ux.state.started" },
  completed: { name: "Done", key: "ux.state.completed" },
  cancelled: { name: "Cancelled", key: "ux.state.cancelled" },
  triage: { name: "Triage", key: "ux.state.triage" },
};

/**
 * Display name of a state: under v2 the EXACT default name of its group is shown in the UI language
 * (Backlog → «Бэклог» …); renamed or custom states and wave 0 (v1) keep the stored name. Data is never changed.
 */
export function getPpmStateDisplayName(
  state: { name: string; group: string } | null | undefined,
  locale: string | undefined
): string | undefined {
  if (!state) return undefined;
  const preset = PPM_DEFAULT_STATES[state.group];
  if (!preset || preset.name !== state.name || !isPpmDesignV2()) return state.name;
  return getPpmTranslation(locale, preset.key);
}

/**
 * Same display rule for a bare state name (activity records keep only the name): an EXACT default name is shown in
 * the UI language under v2, anything else as stored.
 */
export function getPpmStateDisplayNameByName(name: string | undefined, locale: string | undefined): string | undefined {
  if (!name || !isPpmDesignV2()) return name;
  const preset = Object.values(PPM_DEFAULT_STATES).find((item) => item.name === name);
  return preset ? getPpmTranslation(locale, preset.key) : name;
}
