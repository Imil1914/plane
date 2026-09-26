/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useEffect, useMemo, useState } from "react";
import { observer } from "mobx-react";
import { Network } from "lucide-react";
import Link from "next/link";
import { isPpmShellEnabled } from "@ppm/brand";
import { isPpmAntyFlowShellEnabled, isPpmCanvasEnabled } from "@ppm/canvas";
import { SidebarPropertyListItem } from "@/components/common/layout/sidebar/property-list-item";
import { fillCanvasTemplate } from "@/components/ppm-canvas/canvas-grammar";
import { canvasShapeLinkPath } from "@/components/ppm-canvas/living-map/shape-link";
import { useWorkspace } from "@/hooks/store/use-workspace";
import { usePpmTranslation } from "@/hooks/use-ppm-translation";
import { usePpmDesignV2 } from "@/lib/ppm-design";
import { PpmCanvasChangesService, type TPpmWorkItemBoard } from "@/services/ppm-canvas-changes.service";

// Итоговое ревью M-4: и рабочее пространство досок AntyFlow — как ppm-canvas/route.tsx. В минимальном режиме Холста
// (PPM_ANTYFLOW_SHELL_ENABLED=0) одна доска и ?board=/?shape= не читаются: ссылка открыла бы другую доску без выделения.
const CANVAS_ENABLED =
  isPpmCanvasEnabled(
    process.env.PPM_CANVAS_ENABLED,
    isPpmShellEnabled(process.env.PPM_SHELL_ENABLED, process.env.PPM_BRAND_ENABLED)
  ) && isPpmAntyFlowShellEnabled(process.env.PPM_ANTYFLOW_SHELL_ENABLED);

function CanvasBoardsIcon({ className }: { className?: string }) {
  return <Network aria-hidden="true" className={className} />;
}

type TPpmIssueCanvasBoardsProps = {
  issueId: string;
  projectId: string;
  workspaceSlug: string;
};

// AF2.2 C3 · «На карте»: доски Холста, где задача лежит живой карточкой (S4 — по строке на доску, только читаемые, без
// архивных, с проверкой видимости задачи). Только облик v2 и включённый Холст в режиме AntyFlow (не минимальный); пусто
// или ошибка — строки нет вовсе.
// Ссылка открывает доску и выделяет карточку (глубокая ссылка F: canvasShapeLinkPath → ?board=…&shape=…).
export const PpmIssueCanvasBoards = observer(function PpmIssueCanvasBoards({
  issueId,
  projectId,
  workspaceSlug,
}: TPpmIssueCanvasBoardsProps) {
  const designV2 = usePpmDesignV2();
  const ppmT = usePpmTranslation();
  const { getWorkspaceBySlug } = useWorkspace();
  const workspaceId = getWorkspaceBySlug(workspaceSlug)?.id;
  const service = useMemo(() => new PpmCanvasChangesService(), []);
  const [boards, setBoards] = useState<TPpmWorkItemBoard[]>([]);

  useEffect(() => {
    setBoards([]);
    if (!designV2 || !CANVAS_ENABLED || !workspaceId) return;
    let active = true;
    const load = async () => {
      try {
        const response = await service.getWorkItemBoards(workspaceId, projectId, issueId);
        if (active) setBoards(response.results);
      } catch {
        // Задача невидима (404), Холст выключен на сервере или сеть — строки «На карте» просто нет.
        if (active) setBoards([]);
      }
    };
    void load();
    return () => {
      active = false;
    };
  }, [designV2, issueId, projectId, service, workspaceId]);

  if (!designV2 || boards.length === 0) return null;
  return (
    <SidebarPropertyListItem icon={CanvasBoardsIcon} label={ppmT("issue.canvas_boards.label")}>
      <ul className="flex w-full min-w-0 flex-col">
        {boards.map((board) => (
          <li key={board.board_id} className="min-w-0">
            <Link
              href={canvasShapeLinkPath(workspaceSlug, projectId, board.board_id, board.shape_id)}
              className="flex h-7.5 items-center truncate px-2 text-body-xs-regular text-primary hover:underline"
              title={fillCanvasTemplate(ppmT("issue.canvas_boards.open"), { name: board.name })}
            >
              {board.name}
            </Link>
          </li>
        ))}
      </ul>
    </SidebarPropertyListItem>
  );
});
