import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { BrainCircuit, LoaderCircle } from "lucide-react";
import type { TPpmCanvasBoard } from "@ppm/canvas";
import { usePpmTranslation } from "@/hooks/use-ppm-translation";
import { PpmCanvasService } from "@/services/ppm-canvas.service";

const PpmCanvasEditor = lazy(() => import("./editor"));

type TPpmMinimalCanvasWorkspaceProps = {
  authorId: string;
  canEdit: boolean;
  projectId: string;
  workspaceId: string;
  workspaceSlug: string;
};

export default function PpmMinimalCanvasWorkspace({
  authorId,
  canEdit,
  projectId,
  workspaceId,
  workspaceSlug,
}: TPpmMinimalCanvasWorkspaceProps) {
  const ppmT = usePpmTranslation();
  const service = useMemo(() => new PpmCanvasService(), []);
  const [board, setBoard] = useState<TPpmCanvasBoard>();
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    setError(false);
    try {
      const response = await service.getBoards(workspaceId, projectId);
      setBoard(response.boards.find((item) => item.board_id === response.default_board_id));
    } catch {
      setError(true);
    }
  }, [projectId, service, workspaceId]);

  useEffect(() => void load(), [load]);

  if (!board) {
    return (
      <div className="grid h-full place-items-center bg-surface-1 text-secondary">
        <div className="grid justify-items-center gap-3 text-center">
          {error ? <BrainCircuit className="size-5" /> : <LoaderCircle className="size-5 animate-spin" />}
          <span>{ppmT(error ? "canvas.error_description" : "canvas.loading_description")}</span>
          {error && (
            <button className="rounded-md bg-accent-primary px-3 py-2 text-on-accent" type="button" onClick={load}>
              {ppmT("canvas.reload")}
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <Suspense
      fallback={
        <div className="grid h-full place-items-center bg-surface-1 text-secondary">
          {ppmT("canvas.loading_description")}
        </div>
      }
    >
      <PpmCanvasEditor
        authorId={authorId}
        boardId={board.board_id}
        boards={[board]}
        canEdit={canEdit}
        onOpenBoard={() => undefined}
        projectId={projectId}
        workspaceId={workspaceId}
        workspaceSlug={workspaceSlug}
      />
    </Suspense>
  );
}
