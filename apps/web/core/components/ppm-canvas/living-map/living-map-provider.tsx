// AF2.2 F: провайдер «Живой карты» вокруг <Tldraw> (editor.tsx). Собирает в один контекст факты задач (линия M,
// useLivingMapFacts), индекс изменений (линия C, useBoardChanges), переключатель «Светофора» и окружение доски (args)
// — для карточек (shape.tsx) и правой колонки (CanvasControls). children — тот же <Tldraw>: смена значения
// перерисовывает только потребителей контекста, сам холст не пересоздаётся.
import { useMemo, type ReactNode } from "react";
import { useBoardChanges } from "./board-changes";
import { PpmLivingMapContext, useTrafficLightPreference, type TLivingMapContextValue } from "./living-map-context";
import { useLivingMapFacts } from "./living-map-facts";
import type { TLivingMapArgs } from "./living-map-types";

export function PpmLivingMapProvider({ args, children }: { args: TLivingMapArgs; children: ReactNode }) {
  // Хуки линий вызываются всегда (правила хуков); при args.enabled === false (облик v1) они ничего не запрашивают.
  const map = useLivingMapFacts(args);
  const changes = useBoardChanges(args);
  const [trafficLight, setTrafficLight] = useTrafficLightPreference(args.authorId);
  const value = useMemo<TLivingMapContextValue>(
    () => ({ ...map, args, changes, setTrafficLight, trafficLight }),
    [args, changes, map, setTrafficLight, trafficLight]
  );
  return <PpmLivingMapContext.Provider value={value}>{children}</PpmLivingMapContext.Provider>;
}
