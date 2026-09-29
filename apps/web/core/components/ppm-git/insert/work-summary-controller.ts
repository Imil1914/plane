// G2.3 (line G-Web, G4): fetch lifecycle behind the «Что сделано за период» dialog — DOM-free like
// insert-git-object-picker.ts, so the preset→range→fetch flow and the stale-answer guard are unit-testable without
// React. The calendar math itself lives in work-summary-period.ts; this module only sequences the fetch.
import { getWorkSummaryErrorMessage } from "@/components/ppm-git/insert/errors";
import type { TPpmGitWorkSummary } from "@/services/ppm-git.service";
import { getWorkSummaryPresetRange, validateWorkSummaryRange, type TWorkSummaryPreset } from "./work-summary-period";

export type TWorkSummaryControllerState = {
  preset: TWorkSummaryPreset;
  from: string;
  to: string;
  loading: boolean;
  /** A client-side range problem (e.g. more than 92 days) — blocks the request; never combined with `error`. */
  rangeError?: string;
  error?: string;
  summary?: TPpmGitWorkSummary;
};

export type TWorkSummaryControllerDeps = {
  getSummary: (range: { from: string; to: string }) => Promise<TPpmGitWorkSummary>;
  /** Defaults to `() => new Date()`; a fixed clock makes the "this/last week" presets deterministic in tests. */
  today?: () => Date;
};

export type TWorkSummaryController = {
  getState: () => TWorkSummaryControllerState;
  subscribe: (listener: () => void) => () => void;
  start: () => void;
  dispose: () => void;
  setPreset: (preset: TWorkSummaryPreset) => void;
  setCustomRange: (from: string, to: string) => void;
};

const DEFAULT_PRESET: TWorkSummaryPreset = "this_week";

export function createWorkSummaryController(deps: TWorkSummaryControllerDeps): TWorkSummaryController {
  const today = deps.today ?? (() => new Date());
  let state: TWorkSummaryControllerState = { preset: DEFAULT_PRESET, from: "", to: "", loading: true };
  const listeners = new Set<() => void>();
  let generation = 0;
  let active = false;

  const update = (patch: Partial<TWorkSummaryControllerState>) => {
    state = { ...state, ...patch };
    listeners.forEach((listener) => listener());
  };

  const fetchSummary = async (from: string, to: string) => {
    generation += 1;
    const ticket = generation;
    update({ loading: true, error: undefined, rangeError: undefined, from, to });
    try {
      const summary = await deps.getSummary({ from, to });
      if (!active || ticket !== generation) return;
      update({ loading: false, summary });
    } catch (reason) {
      if (!active || ticket !== generation) return;
      update({ loading: false, summary: undefined, error: getWorkSummaryErrorMessage(reason) });
    }
  };

  const applyPreset = (preset: TWorkSummaryPreset) => {
    if (preset === "custom") {
      update({ preset });
      return;
    }
    const range = getWorkSummaryPresetRange(preset, today());
    update({ preset });
    void fetchSummary(range.from, range.to);
  };

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start: () => {
      active = true;
      state = { preset: DEFAULT_PRESET, from: "", to: "", loading: true };
      applyPreset(DEFAULT_PRESET);
    },
    dispose: () => {
      active = false;
      generation += 1;
    },
    setPreset: applyPreset,
    setCustomRange: (from, to) => {
      const problem = validateWorkSummaryRange(from, to);
      if (problem) {
        update({ preset: "custom", from, to, rangeError: problem, summary: undefined });
        return;
      }
      void fetchSummary(from, to);
    },
  };
}
