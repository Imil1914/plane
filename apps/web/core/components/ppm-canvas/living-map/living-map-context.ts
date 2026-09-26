// AF2.2 F: контекст «Живой карты» — факты задач (линия M), индекс изменений (линия C), переключатель «Светофора» и
// окружение доски (args). Значение по умолчанию безопасно: без провайдера (облик v1, минимальный режим, тесты) виды
// ничего не показывают и никуда не пишут.
import { createContext, useCallback, useContext, useSyncExternalStore } from "react";
import {
  EMPTY_BOARD_CHANGE_INDEX,
  EMPTY_LIVING_MAP_ARGS,
  EMPTY_LIVING_MAP_FACTS,
  type TBoardChangeIndex,
  type TLivingMapArgs,
  type TLivingMapFacts,
} from "./living-map-types";

export type TLivingMapContextValue = TLivingMapFacts & {
  args: TLivingMapArgs;
  changes: TBoardChangeIndex;
  setTrafficLight: (on: boolean) => void;
  trafficLight: boolean;
};

export const PPM_LIVING_MAP_DEFAULT: TLivingMapContextValue = {
  ...EMPTY_LIVING_MAP_FACTS,
  args: EMPTY_LIVING_MAP_ARGS,
  changes: EMPTY_BOARD_CHANGE_INDEX,
  setTrafficLight: () => undefined,
  trafficLight: true,
};

export const PpmLivingMapContext = createContext<TLivingMapContextValue>(PPM_LIVING_MAP_DEFAULT);

export function usePpmLivingMap(): TLivingMapContextValue {
  return useContext(PpmLivingMapContext);
}

// ─────────────── «Светофор»: по умолчанию включён, помнится у пользователя в этом браузере ───────────────

const trafficLightMemory = new Map<string, boolean>();
const trafficLightListeners = new Set<() => void>();

export function trafficLightStorageKey(authorId: string): string {
  return ["ppm", "af22", "traffic-light", authorId].map(encodeURIComponent).join(":");
}

/**
 * On unless this user switched it off in this browser; storage that throws (private mode) reads as «on». The first
 * read is remembered for the page (final-pass F2): useSyncExternalStore asks for the value on every render.
 */
export function readTrafficLightPreference(storage: Pick<Storage, "getItem"> | undefined, authorId: string): boolean {
  const key = trafficLightStorageKey(authorId);
  const remembered = trafficLightMemory.get(key);
  if (remembered !== undefined) return remembered;
  let on = true;
  try {
    on = storage?.getItem(key) !== "off";
  } catch {
    on = true;
  }
  trafficLightMemory.set(key, on);
  return on;
}

/** Remembers the switch for this page at once (every open board tab follows) and, when it can, in the browser. */
export function writeTrafficLightPreference(
  storage: Pick<Storage, "setItem"> | undefined,
  authorId: string,
  on: boolean
): void {
  const key = trafficLightStorageKey(authorId);
  trafficLightMemory.set(key, on);
  try {
    storage?.setItem(key, on ? "on" : "off");
  } catch {
    // Private mode or a full quota: the switch still holds for this page.
  }
  for (const listener of trafficLightListeners) listener();
}

/** Every open board tab of the page follows the switch: a write notifies each subscriber (useTrafficLightPreference). */
export function subscribeTrafficLight(listener: () => void): () => void {
  trafficLightListeners.add(listener);
  return () => {
    trafficLightListeners.delete(listener);
  };
}

function browserStorage(): Storage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

function serverTrafficLight(): boolean {
  return true;
}

/** The user's «Светофор» switch: one value for every open board tab of the page, kept in this browser. */
export function useTrafficLightPreference(authorId: string): [boolean, (on: boolean) => void] {
  const on = useSyncExternalStore(
    subscribeTrafficLight,
    () => readTrafficLightPreference(browserStorage(), authorId),
    serverTrafficLight
  );
  const setOn = useCallback(
    (next: boolean) => writeTrafficLightPreference(browserStorage(), authorId, next),
    [authorId]
  );
  return [on, setOn];
}
