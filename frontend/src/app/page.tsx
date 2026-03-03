"use client";

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";

const LOCAL_ID_KEY = "bannerfall.player.id";
const LOCAL_NAME_KEY = "bannerfall.player.displayName";
const LOCAL_JOIN_CODE_KEY = "bannerfall.lobby.joinCode";
const MAX_FEED_ITEMS = 8;

const fallbackMatch = {
  phase: "waiting",
  round: 1,
  totalRounds: 5,
  secondsRemaining: 0,
  totalSeconds: 15,
};

type Identity = {
  id: string;
  displayName: string;
};

type EngineEvent = {
  tick: number;
  type: string;
  message: string;
  payload: Record<string, unknown> | null;
};

type Snapshot = {
  tick: number;
  started: boolean;
  ended: boolean;
  phase: string;
  phaseRemaining: number;
  round: number;
  totalRounds: number;
  winnerFactionId: number | null;
  selfPlayerId: string | null;
  selfFactionId: number | null;
  factions: {
    id: number;
    factionHp: number;
    playerCount: number;
    aliveCount: number;
    burstLocked: boolean;
    burstCommitCount: number | null;
  }[];
  players: {
    id: string;
    name: string;
    factionId: number;
    level: number;
    xp: number;
    hp: number;
    attackPower: number;
    cooldownRemaining: number;
    isExposed: boolean;
    isAlive: boolean;
    connected: boolean;
    isCommittedToBurst: boolean | null;
    kills: number;
    damageDealt: number;
  }[];
  events: EngineEvent[];
};

type WsEnvelope =
  | { type: "connected"; tickSeconds: number }
  | { type: "lobby_created"; lobbyId: string; joinCode: string }
  | { type: "lobby_joined"; lobbyId: string; joinCode: string; playerId: string; factionId: number; name: string }
  | { type: "joined"; playerId: string; factionId: number; name: string }
  | { type: "state"; lobbyId?: string; joinCode?: string; snapshot: Snapshot }
  | { type: "error"; message: string }
  | { type: string; [key: string]: unknown };

type FeedItem = {
  key: string;
  channel: FeedChannel;
  message: string;
  tick: number | null;
  eventType: string | null;
};

type Notice = {
  id: number;
  kind: "success" | "error" | "info";
  message: string;
  sticky: boolean;
};

type ActionEntry = {
  status: ActionLifecycle;
  message: string | null;
  tick: number | null;
};

type ActionStateMap = Record<ActionType, ActionEntry>;

type SessionInfo = {
  playerId: string;
  factionId: number;
  name: string;
};

type MatchView = "war_room" | "live_combat" | "match_summary";

type ClientState = {
  status: ConnectionStatus;
  reconnectAttempt: number;
  tickSeconds: number;
  snapshot: Snapshot | null;
  session: SessionInfo | null;
  feed: FeedItem[];
  processedEventCount: number;
  lobbyId: string | null;
  joinCode: string | null;
};

type ClientAction =
  | { type: "socket_connecting"; attempt: number }
  | { type: "socket_connected"; tickSeconds: number }
  | { type: "socket_disconnected"; message: string }
  | { type: "incoming_state"; lobbyId: string | null; joinCode: string | null; snapshot: Snapshot }
  | { type: "incoming_error"; message: string }
  | { type: "lobby_context"; lobbyId: string; joinCode: string }
  | { type: "incoming_event"; event: EngineEvent };

const initialClientState: ClientState = {
  status: "connecting",
  reconnectAttempt: 0,
  tickSeconds: 1,
  snapshot: null,
  session: null,
  feed: [],
  processedEventCount: 0,
  lobbyId: null,
  joinCode: null,
};

function clientReducer(state: ClientState, action: ClientAction): ClientState {
  if (action.type === "socket_connecting") {
    return {
      ...state,
      status: action.attempt > 0 ? "reconnecting" : "connecting",
      reconnectAttempt: action.attempt,
    };
  }

  if (action.type === "socket_connected") {
    return {
      ...state,
      status: "connected",
      reconnectAttempt: 0,
      tickSeconds: action.tickSeconds,
    };
  }

  if (action.type === "socket_disconnected") {
    const disconnectedFeed = pushFeedItem(state.feed, {
      key: `disconnect-${state.nextNoticeId}`,
      channel: "error",
      message: action.message,
      tick: state.snapshot?.tick ?? null,
      eventType: "socket_disconnected",
    });

    return {
      ...state,
      status: "disconnected",
      feed: [{ kind: "error", message: action.message }, ...state.feed].slice(0, MAX_FEED_ITEMS),
    };
  }

  if (action.type === "lobby_context") {
    return { ...state, lobbyId: action.lobbyId, joinCode: action.joinCode };
  }

  if (action.type === "incoming_state") {
    const nextFeed = [...state.feed];
    const nextSeenEventKeys = [...state.seenEventKeys];

    for (const event of action.snapshot.events) {
      const key = buildEventKey(event);
      if (nextSeenEventKeys.includes(key)) {
        continue;
      }

      nextSeenEventKeys.unshift(key);
      nextFeed.unshift({
        key,
        channel: classifyEventChannel(event.type),
        message: event.message,
        tick: event.tick,
        eventType: event.type,
      });
    }

    return {
      ...state,
      lobbyId: action.lobbyId ?? state.lobbyId,
      joinCode: action.joinCode ?? state.joinCode,
      snapshot: action.snapshot,
      feed: nextFeed.slice(0, MAX_FEED_ITEMS),
      seenEventKeys: nextSeenEventKeys.slice(0, MAX_SEEN_EVENT_KEYS),
    };
  }

  if (action.type === "incoming_ack") {
    if (!isActionType(action.action)) {
      return state;
    }

    const ackedLabel = actionLabel(action.action);
    const shouldShowAckNotice = action.action !== "manual_attack" && action.action !== "burst_commit";

    return {
      ...state,
      pendingAction: state.pendingAction === action.action ? null : state.pendingAction,
      actionStates: {
        ...state.actionStates,
        [action.action]: {
          status: "acked",
          message: `${ackedLabel} confirmed`,
          tick: action.tick,
        },
      },
      notice: shouldShowAckNotice
        ? {
            id: state.nextNoticeId,
            kind: "success",
            message: `${ackedLabel} confirmed`,
            sticky: false,
          }
        : state.notice,
      nextNoticeId: shouldShowAckNotice ? state.nextNoticeId + 1 : state.nextNoticeId,
      feed: pushFeedItem(state.feed, {
        key: `ack-${action.action}-${action.tick}`,
        channel: "system",
        message: `${ackedLabel} acknowledged at t${action.tick}`,
        tick: action.tick,
        eventType: "ack",
      }),
    };
  }

  if (action.type === "incoming_error") {
    return {
      ...state,
      feed: [{ kind: "error", message: action.message }, ...state.feed].slice(0, MAX_FEED_ITEMS),
    };
  }

  const entry = state.actionStates[action.actionType];
  if (entry.status !== "acked") {
    return state;
  }

  return {
    ...state,
    feed: [{ kind: "event", message: action.event.message, tick: action.event.tick }, ...state.feed].slice(
      0,
      MAX_FEED_ITEMS,
    ),
  };
}

export default function Home() {
  const [identity] = useState<Identity | null>(() => bootstrapIdentity());
  const [joinCodeInput, setJoinCodeInput] = useState(() => {
    if (typeof window === "undefined") {
      return "";
    }
    return localStorage.getItem(LOCAL_JOIN_CODE_KEY) ?? "";
  });
  const [clientState, dispatch] = useReducer(clientReducer, initialClientState);
  const socketRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<number | null>(null);
  const reconnectAttemptRef = useRef(0);

  useEffect(() => {
    if (!identity) {
      return;
    }

    let disposed = false;

    const clearReconnectTimer = () => {
      if (reconnectTimeoutRef.current !== null) {
        window.clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
    };

    const scheduleReconnect = () => {
      if (disposed || reconnectTimeoutRef.current !== null) {
        return;
      }

      const attempt = reconnectAttemptRef.current + 1;
      dispatch({ type: "socket_reconnecting", attempt });

      const delayMs = Math.min(RECONNECT_BASE_DELAY_MS * 2 ** (attempt - 1), RECONNECT_MAX_DELAY_MS);
      reconnectTimeoutRef.current = window.setTimeout(() => {
        reconnectTimeoutRef.current = null;
        reconnectAttemptRef.current = attempt;
        connectSocket();
      }, delayMs);
    };

    const connectSocket = () => {
      if (disposed) {
        return;
      }

      dispatch({ type: "socket_connecting", attempt: reconnectAttemptRef.current });

      const socket = new WebSocket(resolveWebSocketUrl());
      socketRef.current = socket;

      socket.addEventListener("open", () => {
        if (disposed || socketRef.current !== socket) {
          socket.close(1000, "stale_socket");
          return;
        }

        reconnectAttemptRef.current = 0;
      });

      socket.addEventListener("message", (raw) => {
        if (disposed || socketRef.current !== socket) {
          return;
        }

        const parsed = parseEnvelope(raw.data);
        if (!parsed) {
          dispatch({ type: "incoming_error", message: "Received invalid server payload." });
          return;
        }

      if (parsed.type === "connected") {
        dispatch({ type: "socket_connected", tickSeconds: parsed.tickSeconds });
        return;
      }

      if (parsed.type === "lobby_created") {
        setJoinCodeInput(parsed.joinCode);
        localStorage.setItem(LOCAL_JOIN_CODE_KEY, parsed.joinCode);
        dispatch({ type: "lobby_context", lobbyId: parsed.lobbyId, joinCode: parsed.joinCode });
        return;
      }

      if (parsed.type === "lobby_joined") {
        setJoinCodeInput(parsed.joinCode);
        localStorage.setItem(LOCAL_JOIN_CODE_KEY, parsed.joinCode);
        dispatch({ type: "lobby_context", lobbyId: parsed.lobbyId, joinCode: parsed.joinCode });
        return;
      }

      if (parsed.type === "state") {
        dispatch({
          type: "incoming_state",
          lobbyId: parsed.lobbyId ?? null,
          joinCode: parsed.joinCode ?? null,
          snapshot: parsed.snapshot,
        });
        return;
      }

        if (parsed.type === "state" && parsed.snapshot && typeof parsed.snapshot === "object") {
          dispatch({ type: "incoming_state", snapshot: parsed.snapshot as Snapshot });
          return;
        }

        if (parsed.type === "ack" && typeof parsed.action === "string" && typeof parsed.tick === "number") {
          dispatch({ type: "incoming_ack", action: parsed.action, tick: parsed.tick });
          return;
        }

        if (parsed.type === "error" && typeof parsed.message === "string") {
          dispatch({ type: "incoming_error", message: parsed.message });
        }
      });

      socket.addEventListener("close", () => {
        if (socketRef.current === socket) {
          socketRef.current = null;
        }

        if (disposed) {
          return;
        }

        dispatch({ type: "socket_disconnected", message: "Connection lost. Reconnecting..." });
        scheduleReconnect();
      });

      socket.addEventListener("error", () => {
        if (disposed || socketRef.current !== socket) {
          return;
        }

        dispatch({ type: "incoming_error", message: "Unable to reach websocket server." });
      });
    };

    connectSocket();

    return () => {
      disposed = true;
      clearReconnectTimer();

      const socket = socketRef.current;
      socketRef.current = null;
      if (!socket) {
        return;
      }

      if (socket.readyState === WebSocket.OPEN) {
        socket.close(1000, "component_cleanup");
        return;
      }

      if (socket.readyState === WebSocket.CONNECTING) {
        socket.addEventListener(
          "open",
          () => {
            socket.close(1000, "component_cleanup");
          },
          { once: true },
        );
      }
    };
  }, [identity]);

  useEffect(() => {
    if (!state.notice || state.notice.sticky) {
      return;
    }

    const noticeId = state.notice.id;
    const timer = window.setTimeout(() => {
      dispatch({ type: "clear_notice", id: noticeId });
    }, NOTICE_AUTO_CLEAR_MS);

    return () => {
      window.clearTimeout(timer);
    };
  }, [state.notice]);

  useEffect(() => {
    const timers: number[] = [];

    for (const actionType of ACTION_TYPES) {
      if (state.actionStates[actionType].status !== "acked") {
        continue;
      }

      const timer = window.setTimeout(() => {
        dispatch({ type: "clear_action_feedback", actionType });
      }, ACK_RESET_MS);

      timers.push(timer);
    }

    return () => {
      for (const timer of timers) {
        window.clearTimeout(timer);
      }
    };
  }, [state.actionStates]);

  useEffect(() => {
    if (!state.session || typeof window === "undefined") {
      return;
    }

    localStorage.setItem(LOCAL_ID_KEY, state.session.playerId);
    localStorage.setItem(LOCAL_NAME_KEY, state.session.name);
  }, [state.session]);

  const sendPayload = (payload: Record<string, unknown>) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      dispatch({ type: "incoming_error", message: "Action failed: websocket is not connected." });
      return;
    }

    socket.send(JSON.stringify(payload));
  };

  const sendAction = (type: "manual_attack" | "burst_commit" | "burst_cancel") => {
    sendPayload({ type });
  };

  const createLobby = () => {
    sendPayload({ type: "create_lobby" });
  };

  const joinLobby = () => {
    const normalizedJoinCode = joinCodeInput.trim().toUpperCase();
    if (!normalizedJoinCode) {
      dispatch({ type: "incoming_error", message: "Join code is required." });
      return;
    }

    localStorage.setItem(LOCAL_JOIN_CODE_KEY, normalizedJoinCode);
    sendPayload({ type: "join_lobby", joinCode: normalizedJoinCode, playerId: identity?.id, name: identity?.displayName });
  };

  const joinLegacy = () => {
    sendPayload({ type: "join", playerId: identity?.id, name: identity?.displayName });
  };

  const summary = useMemo(() => {
    if (!clientState.snapshot?.ended) {
      return null;
    }

    const winnerFactionId = clientState.snapshot.winnerFactionId;
    const winnerLabel =
      winnerFactionId === 0 ? "Red Faction" : winnerFactionId === 1 ? "Blue Faction" : "Draw / No winner";

    const totalPlayers = clientState.snapshot.players.length;
    const alivePlayers = clientState.snapshot.players.filter((player) => player.isAlive).length;
    const totalKills = clientState.snapshot.players.reduce((sum, player) => sum + player.kills, 0);
    const totalDamage = clientState.snapshot.players.reduce((sum, player) => sum + player.damageDealt, 0);

  return {
    state,
    sendAction,
  };
}

function StatusStrip({
  connectionStatus,
  reconnectAttempt,
  view,
  phase,
  round,
  totalRounds,
  progressPercent,
  playerLabel,
  lobbyPlayerCount,
  targetLobbySize,
  factions,
  selfFactionId,
  actionStates,
  onAction,
}: {
  connectionStatus: ConnectionStatus;
  reconnectAttempt: number;
  view: MatchView;
  phase: string;
  round: number;
  totalRounds: number;
  progressPercent: number;
  playerLabel: string;
  lobbyPlayerCount: number;
  targetLobbySize: number;
  factions: Array<{ id: number; label: string; playerCount: number; color: string }>;
  selfFactionId: number | null;
  actionStates: ActionStateMap;
  onAction: (action: ActionType) => void;
}) {
  const connectionClass =
    connectionStatus === "connected"
      ? "border-emerald-500/40 bg-emerald-900/30 text-emerald-100"
      : connectionStatus === "reconnecting"
        ? "border-amber-500/40 bg-amber-900/20 text-amber-100"
        : connectionStatus === "connecting"
          ? "border-sky-500/40 bg-sky-900/20 text-sky-100"
          : "border-rose-500/40 bg-rose-900/20 text-rose-100";

  const connectionLabel =
    connectionStatus === "reconnecting"
      ? `reconnecting #${Math.max(1, reconnectAttempt)}`
      : connectionStatus;
  const phaseText = formatPhaseLabel(phase);
  const progressBarClass = phase === "prep" ? "bg-amber-400" : phase === "combat" ? "bg-emerald-400" : "bg-cyan-400";

  const requestLeaveDisabled = connectionStatus !== "connected" || actionStates.request_leave.status === "sending";
  const cancelLeaveDisabled = connectionStatus !== "connected" || actionStates.cancel_leave.status === "sending";

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <main className="mx-auto flex w-full max-w-md flex-col gap-4 px-4 py-5">
        <section className="rounded-xl border border-slate-800 bg-slate-900/80 p-4 shadow-lg shadow-black/20">
          <p className="text-xs uppercase tracking-widest text-slate-400">Bannerfall MVP</p>
          <h1 className="mt-1 text-2xl font-bold tracking-tight">Live Match</h1>
          <p className="mt-2 text-sm text-slate-300">
            {identity ? `${identity.displayName} • ${identity.id}` : "Generating identity..."}
          </p>
          <p className="mt-1 text-xs uppercase tracking-wide text-slate-400">Connection: {clientState.status}</p>
          <p className="mt-1 text-xs uppercase tracking-wide text-slate-400">
            Lobby: {clientState.lobbyId ? `${clientState.joinCode ?? "-"} (${clientState.lobbyId.slice(0, 8)}...)` : "Not joined"}
          </p>

          <div className="mt-3 grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={createLobby}
              disabled={clientState.status !== "connected" || Boolean(selfPlayer)}
              className="rounded-lg border border-emerald-500/50 bg-emerald-600/30 px-3 py-2 text-sm font-semibold transition hover:bg-emerald-500/40 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Create Lobby
            </button>
            <button
              type="button"
              onClick={joinLegacy}
              disabled={clientState.status !== "connected" || Boolean(selfPlayer)}
              className="rounded-lg border border-slate-500/50 bg-slate-600/30 px-3 py-2 text-sm font-semibold transition hover:bg-slate-500/40 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Join Legacy
            </button>
          </div>

          <div className="mt-2 flex gap-2">
            <input
              value={joinCodeInput}
              onChange={(event) => setJoinCodeInput(event.target.value.toUpperCase())}
              placeholder="Join code"
              className="w-full rounded-lg border border-slate-700 bg-slate-950/50 px-3 py-2 text-sm outline-none ring-sky-500 focus:ring"
            />
            <button
              type="button"
              onClick={joinLobby}
              disabled={clientState.status !== "connected" || Boolean(selfPlayer)}
              className="rounded-lg border border-sky-500/50 bg-sky-600/30 px-3 py-2 text-sm font-semibold transition hover:bg-sky-500/40 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Join
            </button>
          </div>

          <div className="mt-4 grid grid-cols-2 gap-3">
            <Stat label="Phase" value={match.phase} />
            <Stat label="Round" value={`${match.round} / ${match.totalRounds}`} />
          </div>

          <div className="mt-4 rounded-lg border border-slate-700 bg-slate-950/40 p-3">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-xs uppercase tracking-wide text-slate-400">⏳ Time Remaining</p>
              <p className="text-sm font-semibold">{match.secondsRemaining}s</p>
            </div>
            <div className="h-2 w-full rounded-full bg-slate-800">
              <div className="h-2 rounded-full bg-amber-400" style={{ width: `${timeRemainingPercent}%` }} />
            </div>
          </div>
        </section>

        <section className="rounded-xl border border-slate-800 bg-slate-900/70 p-4">
          <h2 className="text-lg font-semibold">Faction Health</h2>
          <div className="mt-4 space-y-3">
            {factionHealth.map((faction) => (
              <Bar key={faction.label} label={faction.label} value={faction.value} color={faction.color} />
            ))}
          </div>
        </section>

        <section className="rounded-xl border border-slate-800 bg-slate-900/70 p-4">
          <h2 className="text-lg font-semibold">Player Panel</h2>
          {selfPlayer ? (
            <div className="mt-3 grid grid-cols-2 gap-3">
              <Stat label="Player" value={selfPlayer.name} />
              <Stat label="Level" value={String(selfPlayer.level)} />
              <Stat label="ATK" value={String(selfPlayer.attackPower)} />
              <Stat label="EXP" value={String(selfPlayer.xp)} />
              <Stat
                label="Teammates Ready"
                value={readyCounts ? `${readyCounts.committed} / ${readyCounts.required}` : "-"}
              />
            </div>
          ) : (
            <p className="mt-3 text-sm text-slate-300">Join a lobby to view your player stats.</p>
          )}

          <div className="mt-4 grid grid-cols-2 gap-3">
            <button
              type="button"
              onClick={() => sendAction("manual_attack")}
              disabled={!selfPlayer || clientState.status !== "connected"}
              className="rounded-lg border border-rose-500/50 bg-rose-600/30 px-3 py-2 text-sm font-semibold transition hover:bg-rose-500/40 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Attack
            </button>
            <button
              type="button"
              onClick={() => sendAction(selfPlayer?.isCommittedToBurst ? "burst_cancel" : "burst_commit")}
              disabled={!selfPlayer || clientState.status !== "connected"}
              className="rounded-lg border border-indigo-500/50 bg-indigo-600/30 px-3 py-2 text-sm font-semibold transition hover:bg-indigo-500/40 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {selfPlayer?.isCommittedToBurst
                ? "Cancel"
                : `Burst ${readyCounts?.committed ?? 0}/${readyCounts?.required ?? "-"}`}
            </button>
          </div>
        </section>

        {summary ? (
          <section className="rounded-xl border border-emerald-700/50 bg-emerald-950/30 p-4">
            <h2 className="text-lg font-semibold text-emerald-200">Match Summary</h2>
            <p className="mt-1 text-sm text-emerald-100">Winner: {summary.winnerLabel}</p>
            <div className="mt-3 grid grid-cols-2 gap-3">
              <Stat label="Players" value={`${summary.alivePlayers} / ${summary.totalPlayers} alive`} />
              <Stat label="Total Kills" value={String(summary.totalKills)} />
              <Stat label="Total Damage" value={String(summary.totalDamage)} />
              <Stat label="Final Round" value={`${match.round} / ${match.totalRounds}`} />
            </div>
          </section>
        ) : null}

        <section className="rounded-xl border border-slate-800 bg-slate-900/70 p-4">
          <h2 className="text-lg font-semibold">Event / Error Feed</h2>
          <ul className="mt-3 space-y-2 text-sm text-slate-300">
            {clientState.feed.length === 0 ? <li>Waiting for server events...</li> : null}
            {clientState.feed.map((item, index) => (
              <li key={`${item.message}-${index}`} className={item.kind === "error" ? "text-rose-300" : "text-slate-300"}>
                {item.tick !== undefined ? `[t${item.tick}] ` : ""}
                {item.message}
              </li>
            ))}
          </ul>
        </section>
      </main>
    </div>
  );
}

  return (
    <div className="rounded-xl border border-slate-700/80 bg-slate-950/40 p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-xs uppercase tracking-wide text-slate-400">Player Status</p>
        <p className="truncate text-sm font-semibold text-slate-100">{player.name}</p>
      </div>
      <div className="space-y-1.5 text-sm">
        <StatusLine label="State" value={player.isAlive ? "Alive" : "Eliminated"} />
        <StatusLine label="HP" value={String(Math.round(player.hp))} />
        <StatusLine label="Level / XP" value={`${player.level} / ${player.xp}`} />
        <StatusLine label="ATK" value={String(player.attackPower)} />
      </div>
    </div>
  );
}

function Panel({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-slate-700/80 bg-slate-900/70 p-4 shadow-lg shadow-black/20">
      <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
      <p className="mt-1 text-sm text-slate-400">{subtitle}</p>
      <div className="mt-3">{children}</div>
    </section>
  );
}

function MetricTile({ label, value, compact = false }: { label: string; value: string; compact?: boolean }) {
  return (
    <div className={`rounded-lg border border-slate-700/70 bg-slate-950/40 ${compact ? "p-2" : "p-3"}`}>
      <p className="text-[11px] uppercase tracking-wide text-slate-400">{label}</p>
      <p className={`mt-1 truncate ${compact ? "text-sm font-medium" : "text-lg font-semibold"}`}>{value}</p>
    </div>
  );
}

function ActionButton({
  label,
  disabled,
  tone,
  onClick,
}: {
  label: string;
  disabled: boolean;
  tone: "attack" | "burst" | "neutral";
  onClick: () => void;
}) {
  const toneClass =
    tone === "attack"
      ? "border-rose-500/50 bg-rose-700/30 hover:bg-rose-600/40"
      : tone === "burst"
        ? "border-cyan-500/50 bg-cyan-700/30 hover:bg-cyan-600/40"
        : "border-slate-500/50 bg-slate-700/30 hover:bg-slate-600/40";

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`min-h-11 w-full rounded-xl border px-3 py-2 text-sm font-semibold transition ${toneClass} disabled:cursor-not-allowed disabled:opacity-50`}
    >
      {label}
    </button>
  );
}

function CombatActionPill({
  label,
  disabled,
  tone,
  onClick,
}: {
  label: string;
  disabled: boolean;
  tone: "attack" | "burst";
  onClick: () => void;
}) {
  const toneClass =
    tone === "attack"
      ? "border-rose-500/60 bg-rose-700/25 text-rose-100 hover:bg-rose-600/35"
      : "border-cyan-500/60 bg-cyan-700/25 text-cyan-100 hover:bg-cyan-600/35";

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`min-h-10 w-full rounded-full border px-3 py-2 text-xs font-semibold uppercase tracking-wide transition ${toneClass} disabled:cursor-not-allowed disabled:opacity-50`}
    >
      {label}
    </button>
  );
}

function StatusLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between border-b border-slate-800/80 pb-1 last:border-b-0 last:pb-0">
      <p className="text-xs uppercase tracking-wide text-slate-400">{label}</p>
      <p className="font-medium text-slate-100">{value}</p>
    </div>
  );
}

function bootstrapIdentity(): Identity | null {
  if (typeof window === "undefined") {
    return null;
  }

  const existingId = localStorage.getItem(LOCAL_ID_KEY);
  const existingDisplayName = localStorage.getItem(LOCAL_NAME_KEY);

  const id = existingId ?? crypto.randomUUID();
  const displayName = existingDisplayName ?? generateRandomDisplayName();

  localStorage.setItem(LOCAL_ID_KEY, id);
  localStorage.setItem(LOCAL_NAME_KEY, displayName);

  return { id, displayName };
}

function resolveWebSocketUrl(): string {
  const configuredUrl = process.env.NEXT_PUBLIC_WS_URL?.trim();
  if (configuredUrl) {
    return configuredUrl;
  }

  if (typeof window === "undefined") {
    return `ws://127.0.0.1:${DEFAULT_WS_PORT}`;
  }

  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.hostname}:${DEFAULT_WS_PORT}`;
}

function parseEnvelope(raw: unknown): WsEnvelope | null {
  if (typeof raw !== "string") {
    return null;
  }

  try {
    return JSON.parse(raw) as WsEnvelope;
  } catch {
    return null;
  }
}

function createInitialActionStates(): ActionStateMap {
  return {
    request_leave: { status: "idle", message: null, tick: null },
    cancel_leave: { status: "idle", message: null, tick: null },
    manual_attack: { status: "idle", message: null, tick: null },
    burst_commit: { status: "idle", message: null, tick: null },
    burst_cancel: { status: "idle", message: null, tick: null },
  };
}

function classifyEventChannel(eventType: string): FeedChannel {
  const combatEventTokens = ["attack", "burst", "died", "level_up", "combat", "damage"];
  return combatEventTokens.some((token) => eventType.includes(token)) ? "combat" : "system";
}

function buildEventKey(event: EngineEvent): string {
  return `${event.tick}:${event.type}:${event.message}`;
}

function pushFeedItem(feed: FeedItem[], item: FeedItem): FeedItem[] {
  return [item, ...feed].slice(0, MAX_FEED_ITEMS);
}

function actionLabel(action: ActionType): string {
  if (action === "manual_attack") {
    return "Attack";
  }
  if (action === "burst_commit") {
    return "Burst commit";
  }
  if (action === "burst_cancel") {
    return "Burst cancel";
  }
  if (action === "request_leave") {
    return "Leave request";
  }
  return "Leave cancel";
}

function statusMessage(entry: ActionEntry): string {
  if (entry.status === "sending") {
    return "Sending...";
  }

  if (entry.status === "acked") {
    return entry.message ?? "Confirmed.";
  }

  if (entry.status === "error") {
    return entry.message ?? "Action failed.";
  }

  return "";
}

function getManualAttackBlockReason(
  connectionStatus: ConnectionStatus,
  snapshot: Snapshot | null,
  selfPlayer: Snapshot["players"][number] | null,
): string | null {
  if (connectionStatus !== "connected") {
    return "Actions temporarily unavailable while reconnecting.";
  }

  if (!snapshot?.started || snapshot.phase !== "combat") {
    return "Not in combat phase.";
  }

  if (!selfPlayer) {
    return "Waiting for player sync.";
  }

  if (!selfPlayer.isAlive) {
    return "Dead players cannot attack.";
  }

  if (selfPlayer.cooldownRemaining > 0) {
    return `Cooldown: ${selfPlayer.cooldownRemaining}s`;
  }

  if (selfPlayer.isCommittedToBurst) {
    return "Cancel burst commitment before attacking.";
  }

  return null;
}

function getBurstActionBlockReason(
  connectionStatus: ConnectionStatus,
  snapshot: Snapshot | null,
  selfPlayer: Snapshot["players"][number] | null,
  myFaction: Snapshot["factions"][number] | null,
  burstActionType: ActionType,
): string | null {
  if (connectionStatus !== "connected") {
    return "Actions temporarily unavailable while reconnecting.";
  }

  if (!snapshot?.started || snapshot.phase !== "combat") {
    return "Not in combat phase.";
  }

  if (!selfPlayer) {
    return "Waiting for player sync.";
  }

  if (!selfPlayer.isAlive) {
    return "Dead players cannot change burst commitment.";
  }

  if (myFaction?.burstLocked) {
    return "Burst lock active.";
  }

  if (burstActionType === "burst_cancel" && !selfPlayer.isCommittedToBurst) {
    return "Player is not committed to burst.";
  }

  return null;
}

function isActionType(value: string): value is ActionType {
  return ACTION_TYPES.includes(value as ActionType);
}

function generateRandomDisplayName(): string {
  const adjectives = ["Swift", "Iron", "Silent", "Ember", "Noble", "Arcane"];
  const nouns = ["Falcon", "Warden", "Ranger", "Vanguard", "Sentinel", "Drifter"];

  const adjective = adjectives[Math.floor(Math.random() * adjectives.length)];
  const noun = nouns[Math.floor(Math.random() * nouns.length)];
  const suffix = Math.floor(100 + Math.random() * 900);

  return `${adjective}${noun}${suffix}`;
}

function getPhaseDurationSeconds(phase: string): number {
  if (phase === "prep") {
    return 10;
  }
  if (phase === "combat") {
    return 45;
  }
  if (phase === "transition") {
    return 5;
  }
  return 15;
}

function formatPhaseLabel(phase: string): string {
  if (phase === "war_room") {
    return "WAR ROOM";
  }
  return phase.replaceAll("_", " ").toUpperCase();
}

function factionLabel(factionId: number): string {
  return factionId === 0 ? "Red Faction" : "Blue Faction";
}

function parsePositiveEnvInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  const rounded = Math.round(parsed);
  return rounded > 0 ? rounded : fallback;
}
