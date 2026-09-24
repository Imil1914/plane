const INITIAL_CANVAS_RETRY_MS = 2_000;
const MAX_CANVAS_RETRY_MS = 30_000;

export function canvasSaveRetryDelayMs(attempt: number, random = Math.random()): number {
  const exponent = Math.min(4, Math.max(0, Math.floor(attempt)));
  const backoff = Math.min(MAX_CANVAS_RETRY_MS, INITIAL_CANVAS_RETRY_MS * 2 ** exponent);
  const jitter = 0.8 + Math.min(1, Math.max(0, random)) * 0.4;
  return Math.min(MAX_CANVAS_RETRY_MS, Math.round(backoff * jitter));
}

export function shouldRetryCanvasSave(status: number | undefined): boolean {
  return status === undefined || status === 408 || status === 429 || status >= 500;
}
