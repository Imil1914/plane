// Line U-Web (UX2.1 U6-U8): a deterministic stand-in for the browser (a WebSocket, timers, the clock, tab visibility)
// so the events-client's connection, coalescing and reconnect rules can be checked step by step, without a real
// socket and without jsdom (this suite runs in the plain `node` vitest environment — see vitest.config.ts).
import type { TPpmRealtimeEnv, TPpmRealtimeSocketLike } from "@/components/ppm-realtime/client";
import { PPM_REALTIME_SOCKET_OPEN } from "@/components/ppm-realtime/client";

/** Lets every pending promise callback run (one real macrotask). */
export const flushPromises = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Runs `step` `times` times, one after another (avoids an `await` inside a `for` loop). */
export const repeat = async (
  times: number,
  step: (index: number) => Promise<void> | void,
  index = 0
): Promise<void> => {
  if (index >= times) return;
  await step(index);
  return repeat(times, step, index + 1);
};

const CONNECTING = 0;
const CLOSED = 3;

export class FakeSocket implements TPpmRealtimeSocketLike {
  readonly url: string;
  readyState = CONNECTING;
  sent: unknown[] = [];
  private listeners: Record<string, ((event: { code?: number; data?: unknown }) => void)[]> = {
    open: [],
    message: [],
    close: [],
    error: [],
  };

  constructor(url: string) {
    this.url = url;
  }

  addEventListener(
    type: "open" | "message" | "close" | "error",
    listener: (event: { code?: number; data?: unknown }) => void
  ) {
    this.listeners[type].push(listener);
  }

  send(data: string) {
    this.sent.push(JSON.parse(data));
  }

  close(code = 1000) {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    for (const listener of this.listeners.close) listener({ code });
  }

  /** Test-only: the server accepts the TCP/TLS handshake. */
  open() {
    this.readyState = PPM_REALTIME_SOCKET_OPEN;
    for (const listener of this.listeners.open) listener({});
  }

  /** Test-only: a JSON frame arrives from the server. */
  receive(message: unknown) {
    for (const listener of this.listeners.message) listener({ data: JSON.stringify(message) });
  }

  /** Test-only: the server (or the network) drops the connection with a close code. */
  serverClose(code: number) {
    this.readyState = CLOSED;
    for (const listener of this.listeners.close) listener({ code });
  }

  fail() {
    for (const listener of this.listeners.error) listener({});
  }
}

export function createFakePpmRealtimeEnv(initiallyVisible = true) {
  let now = 0;
  let visible = initiallyVisible;
  let nextId = 1;
  let randomValue = 0.5;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const returnListeners = new Set<() => void>();
  const sockets: FakeSocket[] = [];

  const env: TPpmRealtimeEnv = {
    createSocket: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
    now: () => now,
    setTimer: (callback, ms) => {
      const id = nextId;
      nextId += 1;
      timers.set(id, { at: now + ms, callback });
      return id;
    },
    clearTimer: (handle) => {
      timers.delete(handle as number);
    },
    isVisible: () => visible,
    subscribeReturn: (listener) => {
      returnListeners.add(listener);
      return () => returnListeners.delete(listener);
    },
    random: () => randomValue,
  };

  const nextDue = (until: number) => {
    let due: { id: number; at: number; callback: () => void } | undefined;
    for (const [id, timer] of timers) {
      if (timer.at <= until && (!due || timer.at < due.at)) due = { id, ...timer };
    }
    return due;
  };

  /** Moves the clock forward, firing due timers in order and letting promise callbacks settle after each one. */
  async function advance(ms: number) {
    const target = now + ms;
    const fireNext = async (): Promise<void> => {
      const due = nextDue(target);
      if (!due) return;
      timers.delete(due.id);
      now = due.at;
      due.callback();
      await flushPromises();
      return fireNext();
    };
    await fireNext();
    now = target;
    await flushPromises();
  }

  async function setVisible(value: boolean) {
    visible = value;
    for (const listener of returnListeners) listener();
    await flushPromises();
  }

  return {
    env,
    advance,
    setVisible,
    setRandom: (value: number) => {
      randomValue = value;
    },
    sockets,
    lastSocket: () => sockets.at(-1),
    now: () => now,
    timerCount: () => timers.size,
  };
}
