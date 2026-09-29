// Line U-Web (UX2.1 U5 web mirror, U6): review round 2 (U-API's own review) — the web flag's *parsing rule* now
// matches the server's exactly (an allowlist: only "1"/"true" are on), not just its default; unlike the blocklist
// convention other PPM rollback flags use (`isPpmCanvasEnabled` etc. in packages/ppm-canvas/src/index.ts). The socket
// URL is built the same way the Canvas presence socket's is.
import { describe, expect, it } from "vitest";
import { isPpmRealtimeEventsEnabled } from "@/components/ppm-realtime/flag";
import { buildPpmRealtimeEventsUrl } from "@/components/ppm-realtime/url";

describe("isPpmRealtimeEventsEnabled", () => {
  it("defaults to enabled when unset or blank, matching the server's own default", () => {
    expect(isPpmRealtimeEventsEnabled(undefined)).toBe(true);
    expect(isPpmRealtimeEventsEnabled("")).toBe(true);
    expect(isPpmRealtimeEventsEnabled("  ")).toBe(true);
  });

  it("is enabled only by '1' or 'true', case-insensitively", () => {
    for (const value of ["1", "true", "TRUE", "True"]) expect(isPpmRealtimeEventsEnabled(value)).toBe(true);
  });

  it("fails closed for anything else, including values another PPM flag would treat as enabled", () => {
    for (const value of ["0", "false", "No", "OFF", "disabled", "yes", "enabled", "2", "banana"]) {
      expect(isPpmRealtimeEventsEnabled(value)).toBe(false);
    }
  });
});

describe("buildPpmRealtimeEventsUrl", () => {
  it("builds a workspace-scoped wss:// URL on the API host, dropping query/hash", () => {
    expect(
      buildPpmRealtimeEventsUrl({
        apiBaseUrl: "https://api.ppm.test/base?ignored=1",
        pageOrigin: "https://ppm.test",
        workspaceSlug: "acme co",
      })
    ).toBe("wss://api.ppm.test/ws/ppm/v1/workspaces/acme%20co/events/");
  });

  it("falls back to the page origin, over ws://, when no API base URL is configured", () => {
    expect(
      buildPpmRealtimeEventsUrl({ apiBaseUrl: "", pageOrigin: "http://localhost:3000", workspaceSlug: "acme" })
    ).toBe("ws://localhost:3000/ws/ppm/v1/workspaces/acme/events/");
  });
});
