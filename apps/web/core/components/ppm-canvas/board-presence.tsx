import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Users, WifiOff } from "lucide-react";
import { API_BASE_URL } from "@plane/constants";

export type TPpmPresenceStatus = "connecting" | "degraded" | "denied" | "offline" | "online";

export type TPpmPresenceParticipant = {
  access: "edit" | "read";
  avatar_url: string;
  connection_id: string;
  display_name: string;
  joined_at: string;
  user_id: string;
};

export type TPpmPresenceCursor = {
  connection_id: string;
  display_name: string;
  pointer_down: boolean;
  updated_at: number;
  user_id: string;
  x: number;
  y: number;
};

export type TPpmBoardChange = {
  board_id: string;
  client_operation_id: string;
  content_hash: string;
  saved_at: string;
  saved_by: string;
  version: number;
};

export type TPpmKnownBoardVersion = { board_id: string; version: number };

export type TPpmBoardPresenceController = {
  boardChange?: TPpmBoardChange;
  boardVersion?: TPpmKnownBoardVersion;
  cursors: TPpmPresenceCursor[];
  participants: TPpmPresenceParticipant[];
  sendCursor: (cursor: Pick<TPpmPresenceCursor, "pointer_down" | "x" | "y">) => void;
  status: TPpmPresenceStatus;
};

type TPpmPresenceMessage =
  | { participant: TPpmPresenceParticipant; type: "presence.joined" | "presence.snapshot" }
  | { board_version: number; self: TPpmPresenceParticipant; type: "presence.ready" }
  | { connection_id: string; type: "presence.left"; user_id: string }
  | {
      connection_id: string;
      cursor: { pointer_down: boolean; x: number; y: number };
      display_name: string;
      type: "presence.cursor";
      user_id: string;
    }
  | ({ type: "canvas.board.changed" } & TPpmBoardChange)
  | {
      type: "presence.error" | "presence.heartbeat_ack" | "presence.revoked";
    };

const HEARTBEAT_INTERVAL_MS = 15_000;
const CURSOR_EXPIRY_MS = 5_000;
const CURSOR_SEND_INTERVAL_MS = 1000 / 30;
const MAX_RECONNECT_DELAY_MS = 10_000;

export function buildPpmCanvasPresenceUrl({
  apiBaseUrl,
  boardId,
  pageOrigin,
  projectId,
  workspaceId,
}: {
  apiBaseUrl: string;
  boardId: string;
  pageOrigin: string;
  projectId: string;
  workspaceId: string;
}) {
  const url = new URL(apiBaseUrl || pageOrigin, pageOrigin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `/ws/ppm/v1/workspaces/${encodeURIComponent(workspaceId)}/projects/${encodeURIComponent(projectId)}/canvas/boards/${encodeURIComponent(boardId)}/presence/`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function reducePresenceParticipants(
  participants: Record<string, TPpmPresenceParticipant>,
  message: TPpmPresenceMessage
) {
  if (message.type === "presence.ready") {
    return { ...participants, [message.self.connection_id]: message.self };
  }
  if (message.type === "presence.joined" || message.type === "presence.snapshot") {
    return { ...participants, [message.participant.connection_id]: message.participant };
  }
  if (message.type === "presence.left") {
    if (!participants[message.connection_id]) return participants;
    const next = { ...participants };
    delete next[message.connection_id];
    return next;
  }
  return participants;
}

export function uniquePresenceUsers(participants: Record<string, TPpmPresenceParticipant>) {
  const byUser = new Map<string, TPpmPresenceParticipant>();
  for (const participant of Object.values(participants)) {
    const current = byUser.get(participant.user_id);
    if (!current || participant.joined_at < current.joined_at) byUser.set(participant.user_id, participant);
  }
  const users = [...byUser.values()];
  // oxlint-disable-next-line unicorn/no-array-sort -- `users` is a fresh array created above.
  return users.sort(
    (left, right) => left.display_name.localeCompare(right.display_name) || left.user_id.localeCompare(right.user_id)
  );
}

export function reducePresenceCursors(
  cursors: Record<string, TPpmPresenceCursor>,
  message: TPpmPresenceMessage,
  updatedAt = Date.now(),
  ignoredUserId?: string
) {
  if (message.type === "presence.cursor") {
    if (ignoredUserId && message.user_id === ignoredUserId) return cursors;
    return {
      ...cursors,
      [message.connection_id]: {
        connection_id: message.connection_id,
        display_name: message.display_name,
        pointer_down: message.cursor.pointer_down,
        updated_at: updatedAt,
        user_id: message.user_id,
        x: message.cursor.x,
        y: message.cursor.y,
      },
    };
  }
  if (message.type === "presence.left") {
    if (!cursors[message.connection_id]) return cursors;
    const next = { ...cursors };
    delete next[message.connection_id];
    return next;
  }
  return cursors;
}

export function reduceBoardChange(current: TPpmBoardChange | undefined, message: TPpmPresenceMessage) {
  if (message.type !== "canvas.board.changed") return current;
  if (current && current.board_id === message.board_id && current.version >= message.version) return current;
  return {
    board_id: message.board_id,
    client_operation_id: message.client_operation_id,
    content_hash: message.content_hash,
    saved_at: message.saved_at,
    saved_by: message.saved_by,
    version: message.version,
  };
}

export function reduceKnownBoardVersion(
  current: TPpmKnownBoardVersion | undefined,
  message: TPpmPresenceMessage,
  boardId: string
): TPpmKnownBoardVersion | undefined {
  const version =
    message.type === "presence.ready"
      ? message.board_version
      : message.type === "canvas.board.changed"
        ? message.version
        : undefined;
  if (version === undefined || !Number.isInteger(version) || version < 0) return current;
  if (message.type === "canvas.board.changed" && message.board_id !== boardId) return current;
  if (current?.board_id === boardId && current.version >= version) return current;
  return { board_id: boardId, version };
}

export function resolveBoardChangeAction({
  change,
  currentVersion,
  hasLocalChanges,
  pendingOperationId,
}: {
  change: Pick<TPpmBoardChange, "client_operation_id" | "version">;
  currentVersion: number;
  hasLocalChanges: boolean;
  pendingOperationId?: string;
}): "conflict" | "ignore" | "reload" {
  if (change.version <= currentVersion || change.client_operation_id === pendingOperationId) return "ignore";
  return hasLocalChanges ? "conflict" : "reload";
}

export function resolveBoardSaveCompletion(remoteConflict: boolean, hasNewLocalChanges: boolean) {
  if (remoteConflict) return "conflict";
  return hasNewLocalChanges ? "save_again" : "saved";
}

export function usePpmBoardPresence({
  boardId,
  projectId,
  workspaceId,
}: {
  boardId?: string;
  projectId: string;
  workspaceId: string;
}) {
  const [participants, setParticipants] = useState<Record<string, TPpmPresenceParticipant>>({});
  const [cursors, setCursors] = useState<Record<string, TPpmPresenceCursor>>({});
  const [boardChange, setBoardChange] = useState<TPpmBoardChange>();
  const [boardVersion, setBoardVersion] = useState<TPpmKnownBoardVersion>();
  const [status, setStatus] = useState<TPpmPresenceStatus>("connecting");
  const socketRef = useRef<WebSocket>();
  const selfUserIdRef = useRef<string>();
  const lastCursorSentAtRef = useRef(0);

  const sendCursor = useCallback((cursor: Pick<TPpmPresenceCursor, "pointer_down" | "x" | "y">) => {
    const socket = socketRef.current;
    const now = performance.now();
    if (socket?.readyState !== WebSocket.OPEN || now - lastCursorSentAtRef.current < CURSOR_SEND_INTERVAL_MS) return;
    lastCursorSentAtRef.current = now;
    socket.send(JSON.stringify({ type: "presence.cursor", cursor }));
  }, []);

  useEffect(() => {
    if (!boardId || typeof window === "undefined" || typeof WebSocket === "undefined") {
      setParticipants({});
      setCursors({});
      setBoardChange(undefined);
      setBoardVersion(undefined);
      selfUserIdRef.current = undefined;
      setStatus("offline");
      return;
    }

    let disposed = false;
    let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
    let cursorCleanupTimer: ReturnType<typeof setInterval> | undefined;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let reconnectAttempt = 0;

    const stopHeartbeat = () => {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatTimer = undefined;
    };

    const connect = () => {
      if (disposed) return;
      setParticipants({});
      setCursors({});
      setBoardChange(undefined);
      selfUserIdRef.current = undefined;
      setStatus(navigator.onLine ? "connecting" : "offline");
      if (!navigator.onLine) return;

      const url = buildPpmCanvasPresenceUrl({
        apiBaseUrl: import.meta.env.VITE_API_BASE_URL || API_BASE_URL,
        boardId,
        pageOrigin: window.location.origin,
        projectId,
        workspaceId,
      });
      const socket = new WebSocket(url);
      socketRef.current = socket;

      socket.addEventListener("open", () => {
        if (disposed) return;
        stopHeartbeat();
        heartbeatTimer = setInterval(() => {
          if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "presence.heartbeat" }));
        }, HEARTBEAT_INTERVAL_MS);
      });
      socket.addEventListener("message", (event) => {
        if (disposed || typeof event.data !== "string") return;
        try {
          const message = JSON.parse(event.data) as TPpmPresenceMessage;
          if (message.type === "presence.ready") {
            selfUserIdRef.current = message.self.user_id;
            reconnectAttempt = 0;
            setStatus("online");
          }
          if (message.type === "presence.revoked") {
            setParticipants({});
            setCursors({});
            setBoardChange(undefined);
            setBoardVersion(undefined);
            selfUserIdRef.current = undefined;
            setStatus("denied");
            return;
          }
          setParticipants((current) => reducePresenceParticipants(current, message));
          setCursors((current) => reducePresenceCursors(current, message, Date.now(), selfUserIdRef.current));
          setBoardChange((current) => reduceBoardChange(current, message));
          setBoardVersion((current) => reduceKnownBoardVersion(current, message, boardId));
        } catch {
          // A malformed server frame is ignored; reconnect handles a broken stream.
        }
      });
      socket.addEventListener("error", () => {
        if (!disposed) setStatus("degraded");
      });
      socket.addEventListener("close", (event) => {
        stopHeartbeat();
        if (socketRef.current === socket) socketRef.current = undefined;
        if (disposed) return;
        if ([4401, 4403, 4404].includes(event.code)) {
          setParticipants({});
          setCursors({});
          setBoardChange(undefined);
          setBoardVersion(undefined);
          selfUserIdRef.current = undefined;
          setStatus("denied");
          return;
        }
        setStatus(navigator.onLine ? "degraded" : "offline");
        const delay = Math.min(1000 * 2 ** reconnectAttempt, MAX_RECONNECT_DELAY_MS);
        reconnectAttempt += 1;
        reconnectTimer = setTimeout(connect, delay);
      });
    };

    const handleOnline = () => {
      if (socketRef.current?.readyState === WebSocket.OPEN) return;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      connect();
    };
    const handleOffline = () => {
      setStatus("offline");
      socketRef.current?.close(1000, "offline");
    };

    setParticipants({});
    setCursors({});
    setBoardChange(undefined);
    setBoardVersion(undefined);
    selfUserIdRef.current = undefined;
    connect();
    cursorCleanupTimer = setInterval(() => {
      const oldestAllowed = Date.now() - CURSOR_EXPIRY_MS;
      setCursors((current) => {
        const active = Object.fromEntries(
          Object.entries(current).filter(([, cursor]) => cursor.updated_at >= oldestAllowed)
        );
        return Object.keys(active).length === Object.keys(current).length ? current : active;
      });
    }, 1_000);
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);

    return () => {
      disposed = true;
      stopHeartbeat();
      if (cursorCleanupTimer) clearInterval(cursorCleanupTimer);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      const socket = socketRef.current;
      socketRef.current = undefined;
      if (socket && socket.readyState < WebSocket.CLOSING) socket.close(1000, "board_changed");
    };
  }, [boardId, projectId, workspaceId]);

  return {
    boardChange,
    boardVersion,
    cursors: useMemo(() => Object.values(cursors), [cursors]),
    participants: useMemo(() => uniquePresenceUsers(participants), [participants]),
    sendCursor,
    status,
  } satisfies TPpmBoardPresenceController;
}

export function PpmBoardPresence({ presence }: { presence: TPpmBoardPresenceController }) {
  const { participants, status } = presence;
  const online = status === "online";
  const label =
    status === "denied"
      ? "Доступ к совместной работе закрыт"
      : status === "offline"
        ? "Нет соединения с совместной доской"
        : online
          ? participants.length <= 1
            ? "На доске только вы"
            : `На доске: ${participants.map((participant) => participant.display_name).join(", ")}`
          : "Подключение к совместной доске";

  return (
    <div className="ppm-canvas-presence" data-status={status} aria-label={label} title={label}>
      <span className="ppm-canvas-presence__status" aria-hidden="true" />
      {online && participants.length > 0 ? (
        <span className="ppm-canvas-presence__avatars" aria-hidden="true">
          {participants.slice(0, 3).map((participant) => (
            <span key={participant.user_id}>{presenceInitials(participant.display_name)}</span>
          ))}
        </span>
      ) : status === "offline" || status === "denied" ? (
        <WifiOff aria-hidden="true" />
      ) : (
        <Users aria-hidden="true" />
      )}
      <span>{online ? Math.max(participants.length, 1) : "—"}</span>
    </div>
  );
}

function presenceInitials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return (
    parts
      .slice(0, 2)
      .map((part) => part[0]?.toLocaleUpperCase())
      .join("") || "У"
  );
}
