"use client";

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";

const LOCAL_ID_KEY = "bannerfall.player.id";
const LOCAL_NAME_KEY = "bannerfall.player.displayName";
const DEFAULT_WS_PORT = 8080;
const MAX_FEED_ITEMS = 60;
const MAX_SEEN_EVENT_KEYS = 240;
const NOTICE_AUTO_CLEAR_MS = 1800;
const ACK_RESET_MS = 1400;
const RECONNECT_BASE_DELAY_MS = 500;
const RECONNECT_MAX_DELAY_MS = 5_000;
const TARGET_LOBBY_SIZE = parsePositiveEnvInt(process.env.NEXT_PUBLIC_TARGET_LOBBY_SIZE, 14);

const ACTION_TYPES = ["request_leave", "cancel_leave", "manual_attack", "burst_commit", "burst_cancel"] as const;

type ActionType = (typeof ACTION_TYPES)[number];
type ConnectionStatus = "connecting" | "connected" | "reconnecting" | "disconnected";
type ActionLifecycle = "idle" | "sending" | "acked" | "error";
type FeedChannel = "combat" | "system" | "error";

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
  | { type: "joined"; playerId: string; factionId: number; name: string }
  | { type: "state"; snapshot: Snapshot }
  | { type: "ack"; action: string; tick: number }
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
  seenEventKeys: string[];
  pendingAction: ActionType | null;
  actionStates: ActionStateMap;
  notice: Notice | null;
  nextNoticeId: number;
};

type ClientAction =
  | { type: "socket_connecting"; attempt: number }
  | { type: "socket_connected"; tickSeconds: number }
  | { type: "socket_disconnected"; message: string }
  | { type: "socket_reconnecting"; attempt: number }
  | { type: "incoming_joined"; playerId: string; factionId: number; name: string }
  | { type: "incoming_state"; snapshot: Snapshot }
  | { type: "incoming_ack"; action: string; tick: number }
  | { type: "incoming_error"; message: string }
  | { type: "action_sent"; actionType: ActionType }
  | { type: "clear_notice"; id: number }
  | { type: "clear_action_feedback"; actionType: ActionType };

const initialClientState: ClientState = {
  status: "connecting",
  reconnectAttempt: 0,
  tickSeconds: 1,
  snapshot: null,
  session: null,
  feed: [],
  seenEventKeys: [],
  pendingAction: null,
  actionStates: createInitialActionStates(),
  notice: null,
  nextNoticeId: 1,
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
      feed: disconnectedFeed,
      notice: {
        id: state.nextNoticeId,
        kind: "info",
        message: action.message,
        sticky: true,
      },
      nextNoticeId: state.nextNoticeId + 1,
    };
  }

  if (action.type === "socket_reconnecting") {
    return {
      ...state,
      status: "reconnecting",
      reconnectAttempt: action.attempt,
      notice: {
        id: state.nextNoticeId,
        kind: "info",
        message: `Reconnecting (attempt ${action.attempt})...`,
        sticky: true,
      },
      nextNoticeId: state.nextNoticeId + 1,
    };
  }

  if (action.type === "incoming_joined") {
    const joinedFeed = pushFeedItem(state.feed, {
      key: `joined-${action.playerId}-${state.nextNoticeId}`,
      channel: "system",
      message: `Joined faction ${factionLabel(action.factionId)} as ${action.name}.`,
      tick: state.snapshot?.tick ?? null,
      eventType: "joined",
    });

    return {
      ...state,
      session: {
        playerId: action.playerId,
        factionId: action.factionId,
        name: action.name,
      },
      feed: joinedFeed,
    };
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
    const nextActionStates = { ...state.actionStates };
    if (state.pendingAction) {
      nextActionStates[state.pendingAction] = {
        status: "error",
        message: action.message,
        tick: state.snapshot?.tick ?? null,
      };
    }

    return {
      ...state,
      pendingAction: null,
      actionStates: nextActionStates,
      notice: {
        id: state.nextNoticeId,
        kind: "error",
        message: action.message,
        sticky: true,
      },
      nextNoticeId: state.nextNoticeId + 1,
      feed: pushFeedItem(state.feed, {
        key: `error-${state.nextNoticeId}`,
        channel: "error",
        message: action.message,
        tick: state.snapshot?.tick ?? null,
        eventType: "error",
      }),
    };
  }

  if (action.type === "action_sent") {
    return {
      ...state,
      pendingAction: action.actionType,
      actionStates: {
        ...state.actionStates,
        [action.actionType]: {
          status: "sending",
          message: `Sending ${actionLabel(action.actionType).toLowerCase()}...`,
          tick: state.snapshot?.tick ?? null,
        },
      },
    };
  }

  if (action.type === "clear_notice") {
    if (!state.notice || state.notice.id !== action.id) {
      return state;
    }

    return {
      ...state,
      notice: null,
    };
  }

  const entry = state.actionStates[action.actionType];
  if (entry.status !== "acked") {
    return state;
  }

  return {
    ...state,
    actionStates: {
      ...state.actionStates,
      [action.actionType]: {
        status: "idle",
        message: null,
        tick: null,
      },
    },
  };
}

export default function Home() {
  const [identity] = useState<Identity | null>(() => bootstrapIdentity());
  const [isFeedExpanded, setIsFeedExpanded] = useState(false);
  const { state: clientState, sendAction } = useMatchClient(identity);

  const snapshot = clientState.snapshot;

  const view: MatchView = useMemo(() => {
    if (snapshot?.ended) {
      return "match_summary";
    }

    if (snapshot?.started) {
      return "live_combat";
    }

    return "war_room";
  }, [snapshot]);

  const effectivePlayerId = snapshot?.selfPlayerId ?? clientState.session?.playerId ?? null;

  const selfPlayer = useMemo(() => {
    if (!snapshot || !effectivePlayerId) {
      return null;
    }

    return snapshot.players.find((player) => player.id === effectivePlayerId) ?? null;
  }, [snapshot, effectivePlayerId]);

  const selfFactionId = snapshot?.selfFactionId ?? selfPlayer?.factionId ?? clientState.session?.factionId ?? null;
  const myFaction = useMemo(() => {
    if (!snapshot || selfFactionId === null) {
      return null;
    }

    return snapshot.factions.find((faction) => faction.id === selfFactionId) ?? null;
  }, [snapshot, selfFactionId]);

  const phase = snapshot?.phase ?? "waiting";
  const round = snapshot?.round ?? 0;
  const totalRounds = snapshot?.totalRounds ?? 5;
  const phaseRemaining = snapshot?.phaseRemaining ?? 0;
  const totalPhaseSeconds = getPhaseDurationSeconds(phase);
  const lobbyPlayerCount = snapshot?.players.length ?? 0;
  const phaseProgressPercent = Math.min(100, Math.max(0, Math.round((phaseRemaining / totalPhaseSeconds) * 100)));
  const lobbyProgressPercent = Math.min(
    100,
    Math.round((Math.max(lobbyPlayerCount, 0) / Math.max(TARGET_LOBBY_SIZE, 1)) * 100),
  );
  const topProgressPercent = view === "war_room" ? lobbyProgressPercent : phaseProgressPercent;

  const factionHealth = useMemo(() => {
    if (!snapshot) {
      return [
        { id: 0, label: "Red Faction", hp: 0, aliveCount: 0, playerCount: 0, color: "bg-rose-500" },
        { id: 1, label: "Blue Faction", hp: 0, aliveCount: 0, playerCount: 0, color: "bg-cyan-500" },
      ];
    }

    return [0, 1].map((id) => {
      const faction = snapshot.factions.find((candidate) => candidate.id === id);
      return {
        id,
        label: factionLabel(id),
        hp: faction?.factionHp ?? 0,
        aliveCount: faction?.aliveCount ?? 0,
        playerCount: faction?.playerCount ?? 0,
        color: id === 0 ? "bg-rose-500" : "bg-cyan-500",
      };
    });
  }, [snapshot]);

  const summary = useMemo(() => {
    if (!snapshot?.ended) {
      return null;
    }

    const winnerLabel =
      snapshot.winnerFactionId === 0
        ? "Red Faction"
        : snapshot.winnerFactionId === 1
          ? "Blue Faction"
          : "Draw";

    const totalPlayers = snapshot.players.length;
    const alivePlayers = snapshot.players.filter((player) => player.isAlive).length;
    const totalKills = snapshot.players.reduce((sum, player) => sum + player.kills, 0);
    const totalDamage = snapshot.players.reduce((sum, player) => sum + player.damageDealt, 0);

    return {
      winnerLabel,
      totalPlayers,
      alivePlayers,
      totalKills,
      totalDamage,
      selfStats: selfPlayer
        ? {
            level: selfPlayer.level,
            xp: selfPlayer.xp,
            kills: selfPlayer.kills,
            damage: selfPlayer.damageDealt,
          }
        : null,
    };
  }, [snapshot, selfPlayer]);

  const displayName = clientState.session?.name ?? identity?.displayName ?? "Loading";

  const attackBlockReason = getManualAttackBlockReason(clientState.status, snapshot, selfPlayer);
  const burstActionType: ActionType = selfPlayer?.isCommittedToBurst ? "burst_cancel" : "burst_commit";
  const burstBlockReason = getBurstActionBlockReason(clientState.status, snapshot, selfPlayer, myFaction, burstActionType);

  const combatFeed = clientState.feed.filter((item) => item.channel === "combat");
  const systemFeed = clientState.feed.filter((item) => item.channel !== "combat");

  const reconnectBannerNeeded =
    clientState.status === "disconnected" || clientState.status === "reconnecting" || clientState.status === "connecting";

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <main className="mx-auto flex min-h-screen w-full max-w-6xl flex-col px-3 pb-28 pt-3 sm:px-5 md:pb-8 md:pt-5">
        <StatusStrip
          connectionStatus={clientState.status}
          reconnectAttempt={clientState.reconnectAttempt}
          view={view}
          phase={phase}
          round={round}
          totalRounds={totalRounds}
          progressPercent={topProgressPercent}
          playerLabel={displayName}
          lobbyPlayerCount={lobbyPlayerCount}
          targetLobbySize={TARGET_LOBBY_SIZE}
          factions={factionHealth}
          selfFactionId={selfFactionId}
          actionStates={clientState.actionStates}
          onAction={sendAction}
        />

        {reconnectBannerNeeded ? (
          <div className="mt-3 rounded-xl border border-amber-500/40 bg-amber-900/20 px-4 py-3 text-sm text-amber-100">
            {clientState.status === "connected"
              ? ""
              : clientState.status === "connecting"
                ? "Connecting to match server..."
                : clientState.status === "reconnecting"
                  ? `Reconnecting (attempt ${Math.max(1, clientState.reconnectAttempt)})... Actions are temporarily unavailable.`
                  : "Connection lost. Waiting to reconnect..."}
          </div>
        ) : null}

        {clientState.notice ? <NoticeBanner notice={clientState.notice} /> : null}

        <div
          className={`mt-4 grid gap-4 ${
            view === "war_room" ? "" : "md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] md:items-start"
          }`}
        >
          {view !== "war_room" ? (
            <section className="space-y-4">
            {view === "live_combat" ? (
              <CombatView
                selfPlayer={selfPlayer}
                factions={factionHealth}
              />
            ) : null}

            {view === "match_summary" ? (
              <SummaryView summary={summary} connectionStatus={clientState.status} round={round} totalRounds={totalRounds} />
            ) : null}
            </section>
          ) : null}

          <section className="space-y-4">
            <EventFeed
              combatFeed={combatFeed}
              systemFeed={systemFeed}
              expanded={isFeedExpanded}
              onToggleExpanded={() => setIsFeedExpanded((previous) => !previous)}
            />
          </section>
        </div>

        {view === "live_combat" ? (
          <ActionBar
            attackState={clientState.actionStates.manual_attack}
            burstState={clientState.actionStates[burstActionType]}
            burstActionType={burstActionType}
            attackBlockReason={attackBlockReason}
            burstBlockReason={burstBlockReason}
            onAttack={() => sendAction("manual_attack")}
            onBurst={() => sendAction(burstActionType)}
          />
        ) : null}
      </main>
    </div>
  );
}

function useMatchClient(identity: Identity | null) {
  const [state, dispatch] = useReducer(clientReducer, initialClientState);
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

        if (parsed.type === "connected" && typeof parsed.tickSeconds === "number") {
          dispatch({ type: "socket_connected", tickSeconds: parsed.tickSeconds });
          socket.send(JSON.stringify({ type: "join", playerId: identity.id, name: identity.displayName }));
          return;
        }

        if (
          parsed.type === "joined" &&
          typeof parsed.playerId === "string" &&
          typeof parsed.factionId === "number" &&
          typeof parsed.name === "string"
        ) {
          dispatch({
            type: "incoming_joined",
            playerId: parsed.playerId,
            factionId: parsed.factionId,
            name: parsed.name,
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

  const sendAction = useCallback(
    (actionType: ActionType) => {
      const socket = socketRef.current;
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        dispatch({ type: "incoming_error", message: "Action failed: websocket is not connected." });
        return;
      }

      if (state.actionStates[actionType].status === "sending") {
        return;
      }

      dispatch({ type: "action_sent", actionType });
      socket.send(JSON.stringify({ type: actionType }));
    },
    [state.actionStates],
  );

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
    <header className="rounded-2xl border border-slate-700/80 bg-slate-900/85 px-4 py-4 shadow-lg shadow-black/25 backdrop-blur">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Bannerfall</p>
        <span className={`rounded-full border px-3 py-1 text-xs font-semibold uppercase tracking-wide ${connectionClass}`}>
          {connectionLabel}
        </span>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 text-sm text-slate-300">
        <div className="rounded-lg border border-slate-700/70 bg-slate-950/60 px-3 py-2">
          <p className="text-[10px] uppercase tracking-wide text-slate-400">Name</p>
          <p className="truncate font-semibold text-slate-100">{playerLabel}</p>
        </div>
        <div className="rounded-lg border border-slate-700/70 bg-slate-950/60 px-3 py-2">
          <p className="text-[10px] uppercase tracking-wide text-slate-400">Faction</p>
          <p className="truncate font-semibold text-slate-100">
            {selfFactionId === null ? "Awaiting Assignment" : factionLabel(selfFactionId)}
          </p>
        </div>
      </div>

      <div className="mt-3 rounded-lg border border-slate-700/70 bg-slate-950/60 px-3 py-2">
        <div className="mb-2 flex items-center justify-between text-xs font-semibold uppercase tracking-wide text-slate-300">
          <p>
            ROUND {Math.max(round, 1)} / {totalRounds}
          </p>
          <p>{phaseText}</p>
        </div>
        <div className="h-2.5 w-full rounded-full bg-slate-800">
          <div className={`h-2.5 rounded-full transition-all duration-500 ${progressBarClass}`} style={{ width: `${progressPercent}%` }} />
        </div>
      </div>

      {view === "war_room" ? (
        <div className="mt-3 rounded-lg border border-slate-700/70 bg-slate-950/60 px-3 py-3">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-300">
            <p>
              <span className="uppercase tracking-wide text-slate-400">Lobby Ready</span>{" "}
              <span className="font-semibold text-slate-100">
                {lobbyPlayerCount} / {targetLobbySize}
              </span>
            </p>
            <p>
              <span className="uppercase tracking-wide text-slate-400">Faction</span>{" "}
              <span className="font-semibold text-slate-100">
                {selfFactionId === null ? "Awaiting Assignment" : factionLabel(selfFactionId)}
              </span>
            </p>
          </div>
          <p className="mt-1 text-xs text-slate-400">War starts when the lobby reaches {targetLobbySize} pilots.</p>

          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {factions.map((faction) => (
              <div key={faction.id} className="rounded-lg border border-slate-700/70 bg-slate-950/50 px-3 py-2">
                <div className="mb-1 flex items-center justify-between text-xs">
                  <p className="text-slate-300">{faction.label}</p>
                  <p className="font-semibold text-slate-100">{faction.playerCount}</p>
                </div>
                <div className="h-1.5 w-full rounded-full bg-slate-800">
                  <div
                    className={`h-1.5 rounded-full ${faction.color}`}
                    style={{ width: `${Math.min(100, Math.round((faction.playerCount / Math.max(Math.ceil(targetLobbySize / 2), 1)) * 100))}%` }}
                  />
                </div>
              </div>
            ))}
          </div>

          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            <ActionButton
              label={actionStates.request_leave.status === "sending" ? "Sending..." : "Request Leave"}
              disabled={requestLeaveDisabled}
              tone="neutral"
              onClick={() => onAction("request_leave")}
            />
            <ActionButton
              label={actionStates.cancel_leave.status === "sending" ? "Sending..." : "Cancel Leave"}
              disabled={cancelLeaveDisabled}
              tone="neutral"
              onClick={() => onAction("cancel_leave")}
            />
          </div>

          <div className="mt-2 grid gap-1 text-xs text-slate-400 sm:grid-cols-2">
            <p>{statusMessage(actionStates.request_leave)}</p>
            <p>{statusMessage(actionStates.cancel_leave)}</p>
          </div>
        </div>
      ) : null}
    </header>
  );
}

function NoticeBanner({ notice }: { notice: Notice }) {
  const className =
    notice.kind === "success"
      ? "border-emerald-500/40 bg-emerald-900/25 text-emerald-100"
      : notice.kind === "error"
        ? "border-rose-500/40 bg-rose-900/25 text-rose-100"
        : "border-sky-500/40 bg-sky-900/25 text-sky-100";

  return <div className={`mt-3 rounded-xl border px-4 py-3 text-sm ${className}`}>{notice.message}</div>;
}

function CombatView({
  selfPlayer,
  factions,
}: {
  selfPlayer: Snapshot["players"][number] | null;
  factions: Array<{ id: number; label: string; hp: number; aliveCount: number; playerCount: number; color: string }>;
}) {
  return (
    <section className="space-y-3">
      <div className="space-y-3">
        <FactionHealthCard factions={factions} />
        <PlayerStatusCard player={selfPlayer} />
      </div>
    </section>
  );
}

function SummaryView({
  summary,
  connectionStatus,
  round,
  totalRounds,
}: {
  summary: {
    winnerLabel: string;
    totalPlayers: number;
    alivePlayers: number;
    totalKills: number;
    totalDamage: number;
    selfStats: { level: number; xp: number; kills: number; damage: number } | null;
  } | null;
  connectionStatus: ConnectionStatus;
  round: number;
  totalRounds: number;
}) {
  return (
    <Panel title="Match Summary" subtitle="Outcome and contribution snapshot.">
      <div className="rounded-xl border border-emerald-600/40 bg-emerald-950/20 p-4">
        <p className="text-xs uppercase tracking-wide text-emerald-300">Winner</p>
        <p className="mt-1 text-2xl font-semibold text-emerald-100">{summary?.winnerLabel ?? "Pending"}</p>
        <p className="mt-1 text-sm text-emerald-200">Final round: {Math.max(round, 0)} / {totalRounds}</p>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <MetricTile label="Alive" value={`${summary?.alivePlayers ?? 0} / ${summary?.totalPlayers ?? 0}`} />
        <MetricTile label="Total Kills" value={String(summary?.totalKills ?? 0)} />
        <MetricTile label="Total Damage" value={String(Math.round(summary?.totalDamage ?? 0))} />
        <MetricTile
          label="Your Contribution"
          value={summary?.selfStats ? `${summary.selfStats.kills} K / ${Math.round(summary.selfStats.damage)} DMG` : "-"}
        />
      </div>

      <p className="mt-4 text-sm text-slate-300">
        {connectionStatus === "connected"
          ? "Waiting for next war room state from server."
          : "Disconnected from server. Reconnect to receive next war room state."}
      </p>
    </Panel>
  );
}

function ActionBar({
  attackState,
  burstState,
  burstActionType,
  attackBlockReason,
  burstBlockReason,
  onAttack,
  onBurst,
}: {
  attackState: ActionEntry;
  burstState: ActionEntry;
  burstActionType: ActionType;
  attackBlockReason: string | null;
  burstBlockReason: string | null;
  onAttack: () => void;
  onBurst: () => void;
}) {
  const attackDisabled = Boolean(attackBlockReason) || attackState.status === "sending";
  const burstDisabled = Boolean(burstBlockReason) || burstState.status === "sending";

  const burstLabelBase = burstActionType === "burst_cancel" ? "Cancel" : "Burst";

  return (
    <div className="fixed bottom-0 left-0 right-0 z-40 border-t border-slate-700/80 bg-slate-950/95 px-3 py-2 backdrop-blur md:static md:mt-4 md:rounded-2xl md:border">
      <div className="mx-auto w-full max-w-6xl">
        <div className="grid grid-cols-2 gap-2">
          <CombatActionPill
            label={attackState.status === "sending" ? "Sending..." : "Attack"}
            disabled={attackDisabled}
            tone="attack"
            onClick={onAttack}
          />
          <CombatActionPill
            label={burstState.status === "sending" ? "Sending..." : burstLabelBase}
            disabled={burstDisabled}
            tone="burst"
            onClick={onBurst}
          />
        </div>

        <div className="mt-1 grid grid-cols-2 gap-2 text-[11px] text-slate-400">
          <p className="truncate">{attackBlockReason ?? statusMessage(attackState)}</p>
          <p className="truncate">{burstBlockReason ?? statusMessage(burstState)}</p>
        </div>
      </div>
    </div>
  );
}

function FactionHealthCard({
  factions,
}: {
  factions: Array<{ id: number; label: string; hp: number; aliveCount: number; playerCount: number; color: string }>;
}) {
  return (
    <div className="rounded-xl border border-slate-700/80 bg-slate-950/40 p-3">
      <div className="space-y-2">
        {factions.map((faction) => (
          <div key={faction.id} className="rounded-lg border border-slate-700/70 bg-slate-950/50 p-2.5">
            <div className="mb-1 flex items-center justify-between text-sm">
              <span>{faction.label}</span>
              <span className="font-semibold">{Math.round(faction.hp)} HP</span>
            </div>
            <div className="h-2 w-full rounded-full bg-slate-800">
              <div className={`h-2 rounded-full ${faction.color}`} style={{ width: `${Math.max(0, Math.min(100, faction.hp / 90))}%` }} />
            </div>
            <p className="mt-1 text-xs text-slate-400">
              {faction.aliveCount} alive / {faction.playerCount} total
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}

function EventFeed({
  combatFeed,
  systemFeed,
  expanded,
  onToggleExpanded,
}: {
  combatFeed: FeedItem[];
  systemFeed: FeedItem[];
  expanded: boolean;
  onToggleExpanded: () => void;
}) {
  return (
    <Panel title="Event Feed" subtitle="Combat and system stream">
      <button
        type="button"
        onClick={onToggleExpanded}
        className="mb-3 rounded-lg border border-slate-700/70 bg-slate-950/40 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-slate-300 sm:hidden"
      >
        {expanded ? "Collapse feed" : "Expand feed"}
      </button>

      <div className={`${expanded ? "block" : "hidden"} space-y-4 sm:block`}>
        <FeedSection title="Combat" items={combatFeed} emptyText="No combat events yet." />
        <FeedSection title="System / Errors" items={systemFeed} emptyText="No system messages yet." />
      </div>
    </Panel>
  );
}

function FeedSection({ title, items, emptyText }: { title: string; items: FeedItem[]; emptyText: string }) {
  return (
    <section>
      <h3 className="text-xs uppercase tracking-wide text-slate-400">{title}</h3>
      <ul className="mt-2 max-h-56 space-y-1.5 overflow-y-auto rounded-xl border border-slate-700/70 bg-slate-950/40 p-3 text-sm">
        {items.length === 0 ? <li className="text-slate-400">{emptyText}</li> : null}
        {items.map((item) => (
          <li
            key={item.key}
            className={
              item.channel === "error"
                ? "text-rose-300"
                : item.channel === "system"
                  ? "text-cyan-200"
                  : "text-slate-200"
            }
          >
            {item.tick !== null ? `[t${item.tick}] ` : ""}
            {item.message}
          </li>
        ))}
      </ul>
    </section>
  );
}

function PlayerStatusCard({ player }: { player: Snapshot["players"][number] | null }) {
  if (!player) {
    return (
      <div className="rounded-xl border border-slate-700/80 bg-slate-950/40 p-3">
        <p className="text-xs uppercase tracking-wide text-slate-400">Player Status</p>
        <p className="mt-2 text-sm text-slate-300">Waiting for player snapshot.</p>
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