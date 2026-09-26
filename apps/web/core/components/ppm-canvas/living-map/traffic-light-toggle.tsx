/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { memo } from "react";
import { usePpmTranslation } from "@/hooks/use-ppm-translation";
import { usePpmLivingMap } from "./living-map-context";

// AF2.2 M3: переключатель «Светофор» в правой колонке (слева от «Доска · Объектов»), вид — пилюля F. Виден, когда на
// доске есть живые карточки задач; значение и его хранение (у пользователя в браузере, одно на все вкладки) — F.
// memo (итоговое ревью, M-2): CanvasControls перерисовывается на каждое изменение фигур (кадр перетаскивания), а у
// переключателя нет пропсов — он перерисовывается только от контекста карты, как кнопка и панель C.
export const PpmTrafficLightToggle = memo(function PpmTrafficLightToggle() {
  const ppmT = usePpmTranslation();
  const { args, facts, setTrafficLight, trafficLight } = usePpmLivingMap();
  if (!args.enabled || facts.size === 0) return null;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={trafficLight}
      className="ppm-living-map-pill ppm-traffic-toggle"
      title={ppmT("canvas.traffic.toggle_hint")}
      onClick={() => setTrafficLight(!trafficLight)}
    >
      <span aria-hidden="true" className="ppm-traffic-toggle__track">
        <span className="ppm-traffic-toggle__thumb" />
      </span>
      {ppmT("canvas.traffic.toggle")}
    </button>
  );
});
