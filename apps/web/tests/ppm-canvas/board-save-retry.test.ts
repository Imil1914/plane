import { describe, expect, it } from "vitest";
import { canvasSaveRetryDelayMs, shouldRetryCanvasSave } from "@/components/ppm-canvas/board-save-retry";

describe("Canvas save retry policy", () => {
  it("backs off with bounded jitter instead of retrying in a tight loop", () => {
    expect(canvasSaveRetryDelayMs(0, 0)).toBe(1_600);
    expect(canvasSaveRetryDelayMs(0, 1)).toBe(2_400);
    expect(canvasSaveRetryDelayMs(1, 0.5)).toBe(4_000);
    expect(canvasSaveRetryDelayMs(2, 0.5)).toBe(8_000);
    expect(canvasSaveRetryDelayMs(20, 1)).toBe(30_000);
  });

  it("retries transport, timeout, rate-limit and server failures but not permanent client errors", () => {
    for (const status of [undefined, 408, 429, 500, 503]) expect(shouldRetryCanvasSave(status)).toBe(true);
    for (const status of [400, 401, 403, 404, 409, 422]) expect(shouldRetryCanvasSave(status)).toBe(false);
  });
});
