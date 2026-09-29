// Line U-Web (UX2.1 U6-U8): the events-client owns one socket per tab, ref-counts which projects screens still care
// about, coalesces incoming events (~300 ms) and reconnects on its own with a growing, jittered pause — stopping for
// good on 4401/4403 (line S's own polling is the fallback then). See research/ux21-facts.md §3 and the plan's
// Review Focus #3/#4 (a dropped socket recovers and catches up; a hidden tab does not pile up refreshes).
import { describe, expect, it, vi } from "vitest";
import { createPpmRealtimeClient, syncPpmRealtimeSubscriptions } from "@/components/ppm-realtime/client";
import { PPM_REALTIME_CLOSE_CODE, PPM_REALTIME_TIMINGS } from "@/components/ppm-realtime/protocol";
import { createFakePpmRealtimeEnv, repeat } from "./fake-env";

const url = () => "wss://api.ppm.test/ws/ppm/v1/workspaces/acme/events/";

function setup(initiallyVisible = true) {
  const fake = createFakePpmRealtimeEnv(initiallyVisible);
  const client = createPpmRealtimeClient(fake.env, url);
  return { fake, client };
}

describe("U6: one socket, subscriptions ref-counted per project", () => {
  it("opens the socket lazily, on the first subscribeProject call", () => {
    const { fake, client } = setup();
    expect(fake.sockets).toHaveLength(0);
    client.subscribeProject("project-1");
    expect(fake.sockets).toHaveLength(1);
    expect(fake.sockets[0]?.url).toBe(url());
  });

  it("sends one subscribe message for two screens open on the same project", async () => {
    const { fake, client } = setup();
    client.subscribeProject("project-1");
    const socket = fake.lastSocket();
    socket!.open();
    client.subscribeProject("project-1"); // a second screen, same tick
    await fake.advance(PPM_REALTIME_TIMINGS.subscribeBatchMs);

    const subscribeMessages = socket!.sent.filter((m: any) => m.type === "subscribe");
    expect(subscribeMessages).toEqual([{ type: "subscribe", project_ids: ["project-1"] }]);
  });

  it("only unsubscribes once every screen on that project has gone", async () => {
    const { fake, client } = setup();
    const disposeA = client.subscribeProject("project-1");
    const socket = fake.lastSocket();
    socket!.open();
    const disposeB = client.subscribeProject("project-1");
    await fake.advance(0);
    socket!.sent = [];

    disposeA();
    await fake.advance(0);
    expect(socket!.sent).toEqual([]);

    disposeB();
    await fake.advance(0);
    expect(socket!.sent).toEqual([{ type: "unsubscribe", project_ids: ["project-1"] }]);
  });

  it("never asks for more than 50 subscriptions in total, even split across batches", async () => {
    const { fake, client } = setup();
    client.subscribeProject("project-start");
    const socket = fake.lastSocket();
    socket!.open(); // reconciles "project-start" immediately, before the loop below queues the rest
    for (let index = 0; index < 55; index += 1) client.subscribeProject(`project-${index}`);
    await fake.advance(0);

    const subscribed = new Set<string>();
    for (const message of socket!.sent as { type: string; project_ids?: string[] }[]) {
      if (message.type === "subscribe") for (const id of message.project_ids ?? []) subscribed.add(id);
    }
    expect(subscribed.size).toBe(50);
  });

  it("pings every 25 s while the socket is open, and stops once it closes", async () => {
    const { fake, client } = setup();
    client.subscribeProject("project-1");
    const socket = fake.lastSocket()!;
    socket.open();
    await fake.advance(0);
    socket.sent = [];

    await fake.advance(PPM_REALTIME_TIMINGS.pingMs);
    expect(socket.sent).toEqual([{ type: "ping" }]);

    socket.sent = [];
    socket.serverClose(1006);
    await fake.advance(PPM_REALTIME_TIMINGS.pingMs);
    expect(socket.sent).toEqual([]); // a fresh reconnect socket exists, but no ping fired on the old, closed one
  });
});

describe("U6: reconnect grows and jitters the pause, and stops for good on 4401/4403", () => {
  it("reconnects after an ordinary drop, with a growing base pause", async () => {
    const { fake, client } = setup();
    client.subscribeProject("project-1");
    fake.setRandom(0); // no jitter spread: isolates the growing base
    fake.lastSocket()!.open();

    fake.lastSocket()!.serverClose(1006);
    expect(fake.sockets).toHaveLength(1);
    await fake.advance(PPM_REALTIME_TIMINGS.reconnectBaseMs / 2 - 1);
    expect(fake.sockets).toHaveLength(1);
    await fake.advance(1);
    expect(fake.sockets).toHaveLength(2); // ~1000 ms (base * 2^0), halved by the jitter floor with random()=0

    fake.lastSocket()!.serverClose(1006);
    await fake.advance(PPM_REALTIME_TIMINGS.reconnectBaseMs - 1); // ~2000 ms this time (base * 2^1)
    expect(fake.sockets).toHaveLength(2);
    await fake.advance(2);
    expect(fake.sockets).toHaveLength(3);
  });

  it("spreads the pause with the injected random(), never past the ceiling", async () => {
    const { fake, client } = setup();
    client.subscribeProject("project-1");
    fake.setRandom(0.999);
    fake.lastSocket()!.open();
    for (let attempt = 0; attempt < 8; attempt += 1) fake.lastSocket()!.serverClose(1006);
    // even after many attempts the pause never exceeds the ceiling
    await fake.advance(PPM_REALTIME_TIMINGS.reconnectMaxMs);
    expect(fake.sockets.length).toBeGreaterThan(1);
  });

  it("gives up for good on 4401 (not authenticated) — no more reconnect attempts", async () => {
    const { fake, client } = setup();
    client.subscribeProject("project-1");
    fake.lastSocket()!.open();
    fake.lastSocket()!.serverClose(4401);

    expect(client.getStatus()).toBe("denied");
    await fake.advance(10 * 60_000);
    expect(fake.sockets).toHaveLength(1); // never retried
  });

  it("gives up for good on 4403 (no workspace access)", () => {
    const { fake, client } = setup();
    client.subscribeProject("project-1");
    fake.lastSocket()!.open();
    fake.lastSocket()!.serverClose(4403);
    expect(client.getStatus()).toBe("denied");
  });

  it("gives up for good on 4404 (review round 2: the channel is disabled server-side)", async () => {
    const { fake, client } = setup();
    client.subscribeProject("project-1");
    fake.lastSocket()!.open();
    fake.lastSocket()!.serverClose(PPM_REALTIME_CLOSE_CODE.channelDisabled);
    expect(client.getStatus()).toBe("denied");
    await fake.advance(10 * 60_000);
    expect(fake.sockets).toHaveLength(1); // never retried
  });

  it("gives up for good on 1009 (review round 2: standard WebSocket messageTooBig)", () => {
    const { fake, client } = setup();
    client.subscribeProject("project-1");
    fake.lastSocket()!.open();
    fake.lastSocket()!.serverClose(PPM_REALTIME_CLOSE_CODE.messageTooBig);
    expect(client.getStatus()).toBe("denied");
  });

  it("reports status transitions: connecting -> online -> degraded", async () => {
    const { fake, client } = setup();
    const statuses: string[] = [];
    client.onStatusChange((status) => statuses.push(status));
    client.subscribeProject("project-1");
    const socket = fake.lastSocket()!;
    socket.open();
    socket.receive({ type: "subscribed", project_ids: ["project-1"], denied: [] });
    socket.serverClose(1006);
    expect(statuses).toEqual(["online", "degraded"]);
  });
});

describe("review round 2: 4429 permanently raises the backoff ceiling, never resets to a fast retry", () => {
  it("does not reset the attempt counter on a subsequent successful subscribe after 4429", async () => {
    const { fake, client } = setup();
    client.subscribeProject("project-1");
    fake.setRandom(0); // isolates the growing base from the jitter spread
    fake.lastSocket()!.open();
    fake.lastSocket()!.serverClose(PPM_REALTIME_CLOSE_CODE.tooManySubscriptions);

    // attempt 0 -> base=1000 (well under the elevated ceiling), delay=500 with random()=0
    await fake.advance(PPM_REALTIME_TIMINGS.reconnectBaseMs / 2);
    expect(fake.sockets).toHaveLength(2);
    fake.lastSocket()!.open();
    fake.lastSocket()!.receive({ type: "subscribed", project_ids: ["project-1"], denied: [] });

    // If `subscribed` had reset the attempt counter, this next retry would again fire after ~500ms. Instead the
    // counter kept growing (attempt=1 now): base=2000, delay=1000 — not yet due at 999ms.
    fake.lastSocket()!.serverClose(PPM_REALTIME_CLOSE_CODE.tooManySubscriptions);
    await fake.advance(PPM_REALTIME_TIMINGS.reconnectBaseMs - 1);
    expect(fake.sockets).toHaveLength(2);
    await fake.advance(2);
    expect(fake.sockets).toHaveLength(3);
  });

  it("saturates at half the elevated ceiling and never drops back to the plain one, even after an ordinary drop", async () => {
    const { fake, client } = setup();
    client.subscribeProject("project-1");
    fake.setRandom(0);
    fake.lastSocket()!.open();
    fake.lastSocket()!.serverClose(PPM_REALTIME_CLOSE_CODE.tooManySubscriptions);

    // Drive enough reconnect/close cycles (mixing in an ordinary 1006) for the exponential base to saturate at the
    // elevated ceiling — once seen, 4429 keeps that ceiling for the rest of the session regardless of later codes.
    await repeat(8, async () => {
      await fake.advance(PPM_REALTIME_TIMINGS.reconnectMaxMsAfterTooMany);
      fake.lastSocket()!.open();
      fake.lastSocket()!.receive({ type: "subscribed", project_ids: ["project-1"], denied: [] });
      fake.lastSocket()!.serverClose(1006);
    });

    const socketCountBefore = fake.sockets.length;
    await fake.advance(PPM_REALTIME_TIMINGS.reconnectMaxMsAfterTooMany / 2 - 1);
    expect(fake.sockets).toHaveLength(socketCountBefore); // never faster than half the elevated ceiling
    await fake.advance(2);
    expect(fake.sockets).toHaveLength(socketCountBefore + 1);
  });
});

describe("review round 2: denied/revoked ids are not re-subscribed until the next reconnect", () => {
  it("does not re-ask for a project denied at subscribe time when reconcile runs again for another project", async () => {
    const { fake, client } = setup();
    client.subscribeProject("project-1");
    const socket = fake.lastSocket()!;
    socket.open();
    await fake.advance(0);
    socket.receive({ type: "subscribed", project_ids: [], denied: ["project-1"] });
    socket.sent = [];

    client.subscribeProject("project-2");
    await fake.advance(0);
    const subscribeMessages = socket.sent.filter((m: any) => m.type === "subscribe");
    expect(subscribeMessages).toEqual([{ type: "subscribe", project_ids: ["project-2"] }]);
  });

  it("does not re-ask for a project revoked mid-connection when reconcile runs again", async () => {
    const { fake, client } = setup();
    client.subscribeProject("project-1");
    const socket = fake.lastSocket()!;
    socket.open();
    await fake.advance(0);
    socket.receive({ type: "subscribed", project_ids: ["project-1"], denied: [] });
    socket.receive({ type: "access_revoked", project_id: "project-1" });
    socket.sent = [];

    client.subscribeProject("project-2");
    await fake.advance(0);
    const subscribeMessages = socket.sent.filter((m: any) => m.type === "subscribe");
    expect(subscribeMessages).toEqual([{ type: "subscribe", project_ids: ["project-2"] }]);
  });

  it("gives the server another chance to re-evaluate a denied project after a fresh reconnect", async () => {
    const { fake, client } = setup();
    client.subscribeProject("project-1");
    let socket = fake.lastSocket()!;
    socket.open();
    await fake.advance(0);
    socket.receive({ type: "subscribed", project_ids: [], denied: ["project-1"] });

    socket.serverClose(1006);
    await fake.advance(PPM_REALTIME_TIMINGS.reconnectMaxMs);
    socket = fake.lastSocket()!;
    socket.open();
    await fake.advance(0);
    const subscribeMessages = socket.sent.filter((m: any) => m.type === "subscribe");
    expect(subscribeMessages).toEqual([{ type: "subscribe", project_ids: ["project-1"] }]);
  });
});

describe("U6: resync after a genuine reconnect, not after the first connect", () => {
  it("does not fire onResync on the very first successful subscribe", () => {
    const { fake, client } = setup();
    const resync = vi.fn();
    client.onResync(resync);
    client.subscribeProject("project-1");
    const socket = fake.lastSocket()!;
    socket.open();
    socket.receive({ type: "subscribed", project_ids: ["project-1"], denied: [] });
    expect(resync).not.toHaveBeenCalled();
  });

  it("fires onResync once, with the live project ids, after a drop and reconnect", async () => {
    const { fake, client } = setup();
    const resync = vi.fn();
    client.onResync(resync);
    client.subscribeProject("project-1");
    fake.lastSocket()!.open();
    fake.lastSocket()!.receive({ type: "subscribed", project_ids: ["project-1"], denied: [] });

    fake.lastSocket()!.serverClose(1006);
    await fake.advance(PPM_REALTIME_TIMINGS.reconnectMaxMs);
    const secondSocket = fake.lastSocket()!;
    secondSocket.open();
    secondSocket.receive({ type: "subscribed", project_ids: ["project-1"], denied: [] });

    expect(resync).toHaveBeenCalledTimes(1);
    expect(resync).toHaveBeenCalledWith(["project-1"]);
  });
});

describe("U1/U-API contract: access_revoked and denied subscriptions", () => {
  it("tells the caller a project was revoked mid-connection, without closing the whole socket", () => {
    const { fake, client } = setup();
    const revoked = vi.fn();
    client.onAccessRevoked(revoked);
    client.subscribeProject("project-1");
    fake.lastSocket()!.open();
    fake.lastSocket()!.receive({ type: "access_revoked", project_id: "project-1" });
    expect(revoked).toHaveBeenCalledWith("project-1");
    expect(client.getStatus()).not.toBe("denied"); // the connection itself stays up for other projects
  });

  it("tells the caller a project was denied at subscribe time", async () => {
    const { fake, client } = setup();
    const revoked = vi.fn();
    client.onAccessRevoked(revoked);
    client.subscribeProject("project-1");
    fake.lastSocket()!.open();
    await fake.advance(0);
    fake.lastSocket()!.receive({ type: "subscribed", project_ids: [], denied: ["project-1"] });
    expect(revoked).toHaveBeenCalledWith("project-1");
  });
});

describe("U7: incoming events are coalesced (~300 ms, max ~1 s under a steady stream)", () => {
  it("merges several updates to the same issue into one entry per flush", async () => {
    const { fake, client } = setup();
    const events = vi.fn();
    client.onEvents(events);
    client.subscribeProject("project-1");
    const socket = fake.lastSocket()!;
    socket.open();

    socket.receive({ type: "event", project_id: "project-1", entity: "issue", action: "updated", ids: ["issue-1"] });
    await fake.advance(100);
    socket.receive({
      type: "event",
      project_id: "project-1",
      entity: "issue",
      action: "updated",
      ids: ["issue-1", "issue-2"],
    });
    await fake.advance(PPM_REALTIME_TIMINGS.eventDebounceMs);

    expect(events).toHaveBeenCalledTimes(1);
    expect(events.mock.calls[0][0].issueUpdated).toEqual([
      { projectId: "project-1", issueIds: ["issue-1", "issue-2"] },
    ]);
  });

  it("buckets created/deleted/moved as one 'list changed' flag per project, not per id", async () => {
    const { fake, client } = setup();
    const events = vi.fn();
    client.onEvents(events);
    client.subscribeProject("project-1");
    const socket = fake.lastSocket()!;
    socket.open();

    socket.receive({ type: "event", project_id: "project-1", entity: "issue", action: "created", ids: ["issue-3"] });
    socket.receive({ type: "event", project_id: "project-1", entity: "issue", action: "moved", ids: ["issue-4"] });
    await fake.advance(PPM_REALTIME_TIMINGS.eventDebounceMs);

    expect(events).toHaveBeenCalledTimes(1);
    expect(events.mock.calls[0][0].issueListChanged).toEqual(["project-1"]);
  });

  it("de-duplicates repeated cycle/module ids across the window", async () => {
    const { fake, client } = setup();
    const events = vi.fn();
    client.onEvents(events);
    client.subscribeProject("project-1");
    const socket = fake.lastSocket()!;
    socket.open();

    socket.receive({ type: "event", project_id: "project-1", entity: "cycle", action: "updated", ids: ["cycle-1"] });
    socket.receive({ type: "event", project_id: "project-1", entity: "module", action: "updated", ids: ["module-1"] });
    socket.receive({ type: "event", project_id: "project-1", entity: "cycle", action: "updated", ids: ["cycle-1"] });
    await fake.advance(PPM_REALTIME_TIMINGS.eventDebounceMs);

    expect(events.mock.calls[0][0].cycleModuleChanged).toEqual(
      expect.arrayContaining([
        { type: "cycle", id: "cycle-1" },
        { type: "module", id: "module-1" },
      ])
    );
    expect(events.mock.calls[0][0].cycleModuleChanged).toHaveLength(2);
  });

  it("never waits longer than eventMaxWaitMs under a steady stream (no starvation)", async () => {
    const { fake, client } = setup();
    const events = vi.fn();
    client.onEvents(events);
    client.subscribeProject("project-1");
    const socket = fake.lastSocket()!;
    socket.open();

    await repeat(6, async (index) => {
      socket.receive({
        type: "event",
        project_id: "project-1",
        entity: "issue",
        action: "updated",
        ids: [`issue-${index}`],
      });
      await fake.advance(200); // < eventDebounceMs, so a naive debounce alone would never fire
    });
    expect(events.mock.calls.length).toBeGreaterThan(0);
  });

  it("reports project entity events distinctly", async () => {
    const { fake, client } = setup();
    const events = vi.fn();
    client.onEvents(events);
    client.subscribeProject("project-1");
    const socket = fake.lastSocket()!;
    socket.open();
    socket.receive({
      type: "event",
      project_id: "project-1",
      entity: "project",
      action: "updated",
      ids: ["project-1"],
    });
    await fake.advance(PPM_REALTIME_TIMINGS.eventDebounceMs);
    expect(events.mock.calls[0][0].projectChanged).toEqual(["project-1"]);
  });
});

describe("U7: a hidden tab defers to one flush on return, never piles up refreshes", () => {
  it("does not flush while hidden, then flushes once everything accumulated on return", async () => {
    const { fake, client } = setup(false);
    const events = vi.fn();
    client.onEvents(events);
    client.subscribeProject("project-1");
    const socket = fake.lastSocket()!;
    socket.open();

    socket.receive({ type: "event", project_id: "project-1", entity: "issue", action: "updated", ids: ["issue-1"] });
    await fake.advance(5000);
    socket.receive({ type: "event", project_id: "project-1", entity: "issue", action: "created", ids: ["issue-2"] });
    await fake.advance(5000);
    expect(events).not.toHaveBeenCalled();

    await fake.setVisible(true);
    expect(events).toHaveBeenCalledTimes(1);
    expect(events.mock.calls[0][0].issueUpdated).toEqual([{ projectId: "project-1", issueIds: ["issue-1"] }]);
    expect(events.mock.calls[0][0].issueListChanged).toEqual(["project-1"]);
  });

  it("does nothing on return when nothing was buffered", async () => {
    const { fake, client } = setup(false);
    const events = vi.fn();
    client.onEvents(events);
    client.subscribeProject("project-1");
    fake.lastSocket()!.open();
    await fake.setVisible(true);
    expect(events).not.toHaveBeenCalled();
  });
});

describe("dispose", () => {
  it("closes the socket and stops every timer", async () => {
    const { fake, client } = setup();
    client.subscribeProject("project-1");
    const socket = fake.lastSocket()!;
    socket.open();
    await fake.advance(0);

    client.dispose();
    expect(socket.readyState).toBe(3);
    await fake.advance(10 * 60_000);
    expect(fake.sockets).toHaveLength(1); // no reconnect after dispose
  });
});

describe("syncPpmRealtimeSubscriptions (review round 1: reactive 'Мои задачи' project list)", () => {
  it("subscribes ids that are new and leaves already-active ones alone", () => {
    const active = new Map<string, () => void>();
    const subscribe = vi.fn((id: string) => vi.fn().mockName(`dispose-${id}`));
    syncPpmRealtimeSubscriptions(active, ["a", "b"], subscribe);
    expect(subscribe).toHaveBeenCalledTimes(2);
    expect([...active.keys()]).toEqual(["a", "b"]);

    subscribe.mockClear();
    syncPpmRealtimeSubscriptions(active, ["a", "b", "c"], subscribe);
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(subscribe).toHaveBeenCalledWith("c");
    expect([...active.keys()]).toEqual(["a", "b", "c"]);
  });

  it("disposes and drops ids that are no longer desired, without touching the rest", () => {
    const disposeA = vi.fn();
    const disposeB = vi.fn();
    const active = new Map<string, () => void>([
      ["a", disposeA],
      ["b", disposeB],
    ]);
    const subscribe = vi.fn();
    syncPpmRealtimeSubscriptions(active, ["b"], subscribe);
    expect(disposeA).toHaveBeenCalledTimes(1);
    expect(disposeB).not.toHaveBeenCalled();
    expect(subscribe).not.toHaveBeenCalled();
    expect([...active.keys()]).toEqual(["b"]);
  });

  it("unsubscribes everything when the desired list becomes empty", () => {
    const disposeA = vi.fn();
    const active = new Map<string, () => void>([["a", disposeA]]);
    syncPpmRealtimeSubscriptions(active, [], vi.fn());
    expect(disposeA).toHaveBeenCalledTimes(1);
    expect(active.size).toBe(0);
  });
});
