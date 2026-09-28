/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

// Линия B (раунд 3): то же, что MultipleSelectGroup (core/components/core/multiple-select/select-group.tsx), плюс
// isEntityHidden — строки свёрнутых групп списка не входят в Shift-диапазон и в переходы стрелками. Отдельная обёртка,
// чтобы не менять общий компонент Plane: «Таблице» и «Таймлайну» скрытые строки не нужны.
import type { MutableRefObject, ReactNode } from "react";
import { observer } from "mobx-react";
import { useMultipleSelect } from "@/hooks/use-multiple-select";
import type { TSelectionHelper } from "@/hooks/use-multiple-select";
import type { TPpmIsEntityHidden } from "@/hooks/use-multiple-select-helpers";

type Props = {
  children: (helpers: TSelectionHelper) => ReactNode;
  containerRef: MutableRefObject<HTMLElement | null>;
  disabled?: boolean;
  entities: Record<string, string[]>; // { groupID: entityIds[] }
  isEntityHidden?: TPpmIsEntityHidden;
};

export const PpmMultipleSelectGroup = observer(function PpmMultipleSelectGroup(props: Props) {
  const { children, containerRef, disabled = false, entities, isEntityHidden } = props;

  const helpers = useMultipleSelect({ containerRef, disabled, entities, isEntityHidden });

  return <>{children(helpers)}</>;
});
