// Масштаб активной доски для строки статуса. Внешний стор вместо состояния workspace: шаг зума перерисовывает
// только кнопку «Масштаб 100 %», а не шапку, рейку и обёртки всех открытых редакторов (notes/risk.md §3.3).
export type TPpmCanvasZoomStore = {
  get: (boardId: string) => number;
  set: (boardId: string, zoom: number) => void;
  subscribe: (listener: () => void) => () => void;
};

export function createCanvasZoomStore(): TPpmCanvasZoomStore {
  const zoomByBoardId = new Map<string, number>();
  const listeners = new Set<() => void>();
  return {
    get: (boardId) => zoomByBoardId.get(boardId) ?? 100,
    set: (boardId, zoom) => {
      if (zoomByBoardId.get(boardId) === zoom) return;
      zoomByBoardId.set(boardId, zoom);
      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
