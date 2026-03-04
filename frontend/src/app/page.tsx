"use client";

import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";

const LOCAL_ID_KEY = "bannerfall.player.id";
const LOCAL_NAME_KEY = "bannerfall.player.displayName";
const DEFAULT_WS_PORT = 8080;
const MAX_FEED_ITEMS = 60;
const MAX_SEEN_EVENT_KEYS = 240;
const NOTICE_AUTO_CLEAR_MS = 1000;
const ACK_RESET_MS = 1400;
const RECONNECT_BASE_DELAY_MS = 0;
const RECONNECT_MAX_DELAY_MS = 0;
const TARGET_LOBBY_SIZE = parsePositiveEnvInt(process.env.NEXT_PUBLIC_TARGET_LOBBY_SIZE, 14);
const LEGACY_LOBBY_ID = "legacy";
const LEGACY_JOIN_CODE = "LEGACY";

const ACTION_TYPES = [
  "request_leave",
  "cancel_leave",
  "manual_attack",
  "burst_commit",
  "burst_cancel",
  "leave_lobby",
] as const;

type ActionType = (typeof ACTION_TYPES)[number];
type ConnectionStatus = "connecting" | "connected" | "reconnecting" | "disconnected";
type ActionLifecycle = "idle" | "sending" | "acked" | "error";
type FeedChannel = "combat" | "system" | "error";
type AppScreen =
  | "bootstrapping_identity"
  | "socket_connecting"
  | "entry_hub"
  | "joining_lobby"
  | "war_room_pre_match"
  | "live_match"
  | "match_summary";
type JoinErrorCategory =
  | "invalid_code"
  | "lobby_full"
  | "bound_elsewhere"
  | "rejoin_cooldown"
  | "match_started"
  | "generic";
type EntryAction = "quick_play" | "create_lobby" | "join_code";

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
  | { type: "state"; lobbyId: string; joinCode: string; snapshot: Snapshot }
  | { type: "ack"; action: string; tick: number; lobbyId?: string; entryCooldownSeconds?: number }
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

type JoinIntent =
  | { kind: "quick_play" }
  | { kind: "create_lobby" }
  | { kind: "join_code"; joinCode: string }
  | { kind: "resume_lobby"; lobbyId: string; joinCode: string | null };

type ClientState = {
  screen: AppScreen;
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
  currentLobbyId: string | null;
  currentJoinCode: string | null;
  joinIntent: JoinIntent | null;
  pendingEntryAction: EntryAction | null;
  entryCooldownEndsAtMs: number | null;
  lastJoinError: { category: JoinErrorCategory; message: string } | null;
  detachedFromLobbyId: string | null;
  pendingDetachedLobbyId: string | null;
  identityResetRequired: boolean;
  lastMatchEndReason: string | null;
};

type ClientAction =
  | { type: "identity_ready" }
  | { type: "socket_connecting"; attempt: number }
  | { type: "socket_connected"; tickSeconds: number }
  | { type: "socket_disconnected"; message: string }
  | { type: "socket_reconnecting"; attempt: number }
  | { type: "entry_join_requested"; intent: JoinIntent; entryAction: EntryAction }
  | { type: "incoming_lobby_created"; lobbyId: string; joinCode: string }
  | { type: "incoming_lobby_joined"; lobbyId: string; joinCode: string; playerId: string; factionId: number; name: string }
  | { type: "incoming_joined"; playerId: string; factionId: number; name: string }
  | { type: "incoming_state"; lobbyId: string; joinCode: string; snapshot: Snapshot }
  | {
      type: "incoming_ack";
      action: string;
      tick: number;
      lobbyId: string | null;
      entryCooldownSeconds: number | null;
    }
  | { type: "incoming_error"; message: string }
  | { type: "action_sent"; actionType: ActionType }
  | { type: "clear_notice"; id: number }
  | { type: "clear_action_feedback"; actionType: ActionType }
  | { type: "clear_detached_notice" }
  | { type: "clear_join_error" }
  | { type: "go_entry" }
  | { type: "identity_rotated"; identity: Identity };

const initialClientState: ClientState = {
  screen: "bootstrapping_identity",
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
  currentLobbyId: null,
  currentJoinCode: null,
  joinIntent: null,
  pendingEntryAction: null,
  entryCooldownEndsAtMs: null,
  lastJoinError: null,
  detachedFromLobbyId: null,
  pendingDetachedLobbyId: null,
  identityResetRequired: false,
  lastMatchEndReason: null,
};

function clientReducer(state: ClientState, action: ClientAction): ClientState {
  if (action.type === "identity_ready") {
    if (state.screen !== "bootstrapping_identity") {
      return state;
    }

    return {
      ...state,
      screen: "socket_connecting",
    };
  }

  if (action.type === "socket_connecting") {
    return {
      ...state,
      status: action.attempt > 0 ? "reconnecting" : "connecting",
      reconnectAttempt: action.attempt,
      screen: state.screen === "bootstrapping_identity" ? "socket_connecting" : state.screen,
    };
  }

  if (action.type === "socket_connected") {
    const shouldShowEntry =
      state.screen === "socket_connecting" &&
      !state.joinIntent &&
      !state.session &&
      !state.pendingEntryAction;

    return {
      ...state,
      status: "connected",
      reconnectAttempt: 0,
      tickSeconds: action.tickSeconds,
      screen: shouldShowEntry ? "entry_hub" : state.screen,
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

  if (action.type === "entry_join_requested") {
    return {
      ...state,
      screen: "joining_lobby",
      pendingEntryAction: action.entryAction,
      joinIntent: action.intent,
      lastJoinError: null,
      identityResetRequired: false,
      detachedFromLobbyId: null,
    };
  }

  if (action.type === "incoming_lobby_created") {
    return {
      ...state,
      currentLobbyId: action.lobbyId,
      currentJoinCode: action.joinCode,
      feed: pushFeedItem(state.feed, {
        key: `lobby-created-${action.lobbyId}`,
        channel: "system",
        message: `Lobby created (${action.joinCode}). Joining...`,
        tick: state.snapshot?.tick ?? null,
        eventType: "lobby_created",
      }),
    };
  }

  if (action.type === "incoming_lobby_joined") {
    const joinedFeed = pushFeedItem(state.feed, {
      key: `lobby-joined-${action.playerId}-${action.lobbyId}`,
      channel: "system",
      message: `Joined lobby ${action.joinCode} as ${action.name} (${factionLabel(action.factionId)}).`,
      tick: state.snapshot?.tick ?? null,
      eventType: "lobby_joined",
    });

    return {
      ...state,
      screen: "war_room_pre_match",
      session: {
        playerId: action.playerId,
        factionId: action.factionId,
        name: action.name,
      },
      currentLobbyId: action.lobbyId,
      currentJoinCode: action.joinCode,
      pendingEntryAction: null,
      lastJoinError: null,
      identityResetRequired: false,
      joinIntent: {
        kind: "resume_lobby",
        lobbyId: action.lobbyId,
        joinCode: action.joinCode,
      },
      feed: joinedFeed,
    };
  }
  if (action.type === "incoming_joined") {
    const joinedFeed = pushFeedItem(state.feed, {
      key: `joined-${action.playerId}-${state.nextNoticeId}`,
      channel: "system",
      message: `Joined as ${action.name} (${factionLabel(action.factionId)}).`,
      tick: state.snapshot?.tick ?? null,
      eventType: "joined",
    });

    const lobbyId = state.currentLobbyId ?? LEGACY_LOBBY_ID;
    const joinCode = state.currentJoinCode ?? LEGACY_JOIN_CODE;

    return {
      ...state,
      screen: "war_room_pre_match",
      session: {
        playerId: action.playerId,
        factionId: action.factionId,
        name: action.name,
      },
      currentLobbyId: lobbyId,
      currentJoinCode: joinCode,
      pendingEntryAction: null,
      joinIntent: {
        kind: "resume_lobby",
        lobbyId,
        joinCode,
      },
      feed: joinedFeed,
    };
  }

  if (action.type === "incoming_state") {
    const nextFeed = [...state.feed];
    const nextSeenEventKeys = [...state.seenEventKeys];
    let nextMatchEndReason = state.lastMatchEndReason;

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

      if (event.type === "match_ended") {
        const reason = extractMatchEndReason(event.payload);
        if (reason) {
          nextMatchEndReason = reason;
        }
      }
    }

    if (!action.snapshot.ended && action.snapshot.started) {
      nextMatchEndReason = null;
    }

    const selfPlayerId = action.snapshot.selfPlayerId;
    const snapshotPlayer =
      selfPlayerId !== null ? action.snapshot.players.find((player) => player.id === selfPlayerId) ?? null : null;

    const nextSession =
      snapshotPlayer !== null
        ? {
            playerId: snapshotPlayer.id,
            factionId: snapshotPlayer.factionId,
            name: snapshotPlayer.name,
          }
        : null;

    const detachedByLeaveAck =
      state.pendingDetachedLobbyId !== null &&
      action.lobbyId === LEGACY_LOBBY_ID &&
      action.snapshot.selfPlayerId === null;

    if (detachedByLeaveAck) {
      return {
        ...state,
        screen: "entry_hub",
        snapshot: action.snapshot,
        currentLobbyId: action.lobbyId,
        currentJoinCode: action.joinCode,
        session: null,
        joinIntent: null,
        pendingEntryAction: null,
        pendingDetachedLobbyId: null,
        detachedFromLobbyId: state.pendingDetachedLobbyId,
        feed: nextFeed.slice(0, MAX_FEED_ITEMS),
        seenEventKeys: nextSeenEventKeys.slice(0, MAX_SEEN_EVENT_KEYS),
        lastMatchEndReason: nextMatchEndReason,
      };
    }

    let nextScreen: AppScreen;
    if (action.snapshot.ended) {
      nextScreen = "match_summary";
    } else if (action.snapshot.started) {
      nextScreen = "live_match";
    } else if (action.snapshot.selfPlayerId !== null) {
      nextScreen = "war_room_pre_match";
    } else if (state.pendingEntryAction) {
      nextScreen = "joining_lobby";
    } else {
      nextScreen = "entry_hub";
    }

    return {
      ...state,
      screen: nextScreen,
      snapshot: action.snapshot,
      currentLobbyId: action.lobbyId,
      currentJoinCode: action.joinCode,
      session: nextSession,
      joinIntent:
        action.snapshot.selfPlayerId !== null
          ? {
              kind: "resume_lobby",
              lobbyId: action.lobbyId,
              joinCode: action.joinCode,
            }
          : state.joinIntent,
      feed: nextFeed.slice(0, MAX_FEED_ITEMS),
      seenEventKeys: nextSeenEventKeys.slice(0, MAX_SEEN_EVENT_KEYS),
      lastMatchEndReason: nextMatchEndReason,
    };
  }

  if (action.type === "incoming_ack") {
    if (!isActionType(action.action)) {
      return state;
    }

    const ackedLabel = actionLabel(action.action);
    const shouldShowAckNotice = action.action !== "manual_attack" && action.action !== "burst_commit";
    const normalizedEntryCooldownSeconds =
      typeof action.entryCooldownSeconds === "number" &&
      Number.isFinite(action.entryCooldownSeconds) &&
      action.entryCooldownSeconds > 0
        ? Math.ceil(action.entryCooldownSeconds)
        : null;
    const nextEntryCooldownEndsAtMs =
      action.action === "leave_lobby" && normalizedEntryCooldownSeconds !== null
        ? Date.now() + normalizedEntryCooldownSeconds * 1000
        : state.entryCooldownEndsAtMs;

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
      pendingDetachedLobbyId:
        action.action === "leave_lobby" ? action.lobbyId ?? state.currentLobbyId : state.pendingDetachedLobbyId,
      entryCooldownEndsAtMs: nextEntryCooldownEndsAtMs,
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

    const isJoinError = state.pendingEntryAction !== null || state.screen === "joining_lobby";
    const joinCategory = classifyJoinError(action.message);

    return {
      ...state,
      screen: isJoinError ? "entry_hub" : state.screen,
      pendingEntryAction: isJoinError ? null : state.pendingEntryAction,
      pendingAction: null,
      actionStates: nextActionStates,
      lastJoinError: isJoinError ? { category: joinCategory, message: action.message } : state.lastJoinError,
      identityResetRequired: isJoinError ? shouldOfferIdentityReset(joinCategory) : state.identityResetRequired,
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

  if (action.type === "clear_action_feedback") {
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

  if (action.type === "clear_detached_notice") {
    return {
      ...state,
      detachedFromLobbyId: null,
    };
  }

  if (action.type === "clear_join_error") {
    return {
      ...state,
      lastJoinError: null,
    };
  }

  if (action.type === "go_entry") {
    return {
      ...state,
      screen: "entry_hub",
      pendingEntryAction: null,
      pendingDetachedLobbyId: null,
      detachedFromLobbyId: null,
      lastJoinError: null,
      identityResetRequired: false,
    };
  }

  if (action.type === "identity_rotated") {
    return {
      ...state,
      lastJoinError: null,
      identityResetRequired: false,
      notice: {
        id: state.nextNoticeId,
        kind: "info",
        message: `Using new pilot ID: ${action.identity.displayName}`,
        sticky: false,
      },
      nextNoticeId: state.nextNoticeId + 1,
    };
  }

  return state;
}

export default function Home() {
  const [identity, setIdentity] = useState<Identity | null>(null);

  useEffect(() => {
    setIdentity(bootstrapIdentity());
  }, []);

  const {
    state: clientState,
    sendMatchAction,
    quickPlay,
    createLobby,
    joinLobbyByCode,
    leaveLobby,
    backToEntry,
    useNewPilotId,
    dismissDetachedNotice,
    dismissJoinError,
  } = useMatchClient(identity, (nextIdentity) => setIdentity(nextIdentity));

  const snapshot = clientState.snapshot;
  const displayName = identity?.displayName ?? clientState.session?.name ?? "Loading";

  const effectivePlayerId = snapshot?.selfPlayerId ?? clientState.session?.playerId ?? null;
  const selfPlayer = useMemo(() => {
    if (!snapshot || !effectivePlayerId) {
      return null;
    }

    return snapshot.players.find((player) => player.id === effectivePlayerId) ?? null;
  }, [snapshot, effectivePlayerId]);

  const selfFactionId =
    snapshot?.selfFactionId ?? selfPlayer?.factionId ?? clientState.session?.factionId ?? null;
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
  const topProgressPercent =
    clientState.screen === "entry_hub" || clientState.screen === "joining_lobby"
      ? lobbyProgressPercent
      : phaseProgressPercent;
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

  const attackBlockReason = getManualAttackBlockReason(clientState.status, snapshot, selfPlayer);
  const burstActionType: ActionType = selfPlayer?.isCommittedToBurst ? "burst_cancel" : "burst_commit";
  const burstBlockReason = getBurstActionBlockReason(
    clientState.status,
    snapshot,
    selfPlayer,
    myFaction,
    burstActionType,
  );

  const combatFeed = clientState.feed.filter((item) => item.channel === "combat");
  const systemFeed = clientState.feed.filter((item) => item.channel !== "combat");
  const reconnectBannerNeeded = clientState.status !== "connected";
  const entryCooldownRemainingSeconds = useEntryCooldownRemainingSeconds(clientState.entryCooldownEndsAtMs);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <main className="mx-auto flex min-h-screen w-full max-w-6xl flex-col px-3 pb-28 pt-3 sm:px-5 md:pb-8 md:pt-5">
        <StatusStrip
          connectionStatus={clientState.status}
          reconnectAttempt={clientState.reconnectAttempt}
          screen={clientState.screen}
          phase={phase}
          round={round}
          totalRounds={totalRounds}
          progressPercent={topProgressPercent}
          playerLabel={displayName}
          lobbyPlayerCount={lobbyPlayerCount}
          targetLobbySize={TARGET_LOBBY_SIZE}
          factions={factionHealth}
          selfFactionId={selfFactionId}
          currentLobbyId={clientState.currentLobbyId}
          currentJoinCode={clientState.currentJoinCode}
        />

        {reconnectBannerNeeded ? (
          <div className="mt-3 rounded-xl border border-amber-500/40 bg-amber-900/20 px-4 py-3 text-sm text-amber-100">
            {clientState.status === "connecting"
              ? "Connecting to match server..."
              : clientState.status === "reconnecting"
                ? `Reconnecting (attempt ${Math.max(1, clientState.reconnectAttempt)})... Actions are temporarily unavailable.`
                : "Connection lost. Waiting to reconnect..."}
          </div>
        ) : null}

        {clientState.notice ? <NoticeBanner notice={clientState.notice} /> : null}

        {/* {clientState.detachedFromLobbyId ? (
          <InlineInfoBanner
            message={buildDetachedNoticeMessage(clientState.detachedFromLobbyId)}
            onDismiss={dismissDetachedNotice}
          />
        ) : null} */}

        <div
          className={`mt-4 grid gap-4 ${
            clientState.screen === "live_match" || clientState.screen === "match_summary"
              ? "md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] md:items-start"
              : ""
          }`}
        >
          <section className="space-y-4">
            {clientState.screen === "bootstrapping_identity" || clientState.screen === "socket_connecting" ? (
              <Panel title="Loading Pilot" subtitle="Preparing identity and websocket session.">
                <p className="text-sm text-slate-300">Initializing local pilot profile...</p>
              </Panel>
            ) : null}

            {clientState.screen === "entry_hub" || clientState.screen === "joining_lobby" ? (
              <EntryHub
                connectionStatus={clientState.status}
                currentJoinCode={clientState.currentJoinCode}
                pendingEntryAction={clientState.pendingEntryAction}
                entryCooldownRemainingSeconds={entryCooldownRemainingSeconds}
                joinError={clientState.lastJoinError}
                identityResetRequired={clientState.identityResetRequired}
                onQuickPlay={quickPlay}
                onCreateLobby={createLobby}
                onJoinByCode={joinLobbyByCode}
                onUseNewPilotId={useNewPilotId}
                onDismissJoinError={dismissJoinError}
              />
            ) : null}

            {clientState.screen === "war_room_pre_match" ? (
              <WarRoomView
                snapshot={snapshot}
                currentLobbyId={clientState.currentLobbyId}
                currentJoinCode={clientState.currentJoinCode}
                selfFactionId={selfFactionId}
                factions={factionHealth}
                connectionStatus={clientState.status}
                actionStates={clientState.actionStates}
                onAction={sendMatchAction}
                onLeaveLobby={leaveLobby}
              />
            ) : null}

            {clientState.screen === "live_match" ? (
              <CombatView selfPlayer={selfPlayer} myFaction={myFaction} factions={factionHealth} onLeaveLobby={leaveLobby} />
            ) : null}

            {clientState.screen === "match_summary" ? (
              <SummaryView
                summary={summary}
                connectionStatus={clientState.status}
                round={round}
                totalRounds={totalRounds}
                reason={clientState.lastMatchEndReason}
                onBackToEntry={backToEntry}
                onUseNewPilotId={useNewPilotId}
              />
            ) : null}
          </section>

          {/* TODO: Only show event feed when already in a lobby. Clear the feed upon joining a new lobby. */}
          {/* <section className="space-y-4">
            <EventFeed combatFeed={combatFeed} systemFeed={systemFeed} />
          </section> */}
        </div>

        {clientState.screen === "live_match" ? (
          <ActionBar
            attackState={clientState.actionStates.manual_attack}
            burstState={clientState.actionStates[burstActionType]}
            burstActionType={burstActionType}
            attackBlockReason={attackBlockReason}
            burstBlockReason={burstBlockReason}
            onAttack={() => sendMatchAction("manual_attack")}
            onBurst={() => sendMatchAction(burstActionType)}
          />
        ) : null}
      </main>
    </div>
  );
}

function useMatchClient(identity: Identity | null, setIdentity: (identity: Identity) => void) {
  const [state, dispatch] = useReducer(clientReducer, initialClientState);
  const socketRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<number | null>(null);
  const reconnectAttemptRef = useRef(0);
  const stateRef = useRef(state);
  const identityRef = useRef(identity);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    identityRef.current = identity;
    if (identity) {
      dispatch({ type: "identity_ready" });
    }
  }, [identity]);

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

    const requestJoinIntent = (socket: WebSocket, intent: JoinIntent, nextIdentity: Identity) => {
      dispatch({
        type: "entry_join_requested",
        intent,
        entryAction: entryActionFromIntent(intent),
      });
      sendJoinIntentMessage(socket, intent, nextIdentity);
    };

    const replayJoinIntent = (socket: WebSocket) => {
      const currentState = stateRef.current;
      const nextIdentity = identityRef.current;
      if (!nextIdentity || !currentState.joinIntent) {
        return;
      }

      requestJoinIntent(socket, currentState.joinIntent, nextIdentity);
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
          replayJoinIntent(socket);
          return;
        }

        if (
          parsed.type === "lobby_created" &&
          typeof parsed.lobbyId === "string" &&
          typeof parsed.joinCode === "string"
        ) {
          dispatch({
            type: "incoming_lobby_created",
            lobbyId: parsed.lobbyId,
            joinCode: parsed.joinCode,
          });

          const currentState = stateRef.current;
          const nextIdentity = identityRef.current;
          if (currentState.joinIntent?.kind === "create_lobby" && nextIdentity) {
            sendJoinIntentMessage(
              socket,
              { kind: "join_code", joinCode: parsed.joinCode },
              nextIdentity,
            );
          }
          return;
        }

        if (
          parsed.type === "lobby_joined" &&
          typeof parsed.lobbyId === "string" &&
          typeof parsed.joinCode === "string" &&
          typeof parsed.playerId === "string" &&
          typeof parsed.factionId === "number" &&
          typeof parsed.name === "string"
        ) {
          dispatch({
            type: "incoming_lobby_joined",
            lobbyId: parsed.lobbyId,
            joinCode: parsed.joinCode,
            playerId: parsed.playerId,
            factionId: parsed.factionId,
            name: parsed.name,
          });
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

        if (
          parsed.type === "state" &&
          parsed.snapshot &&
          typeof parsed.snapshot === "object" &&
          typeof parsed.lobbyId === "string" &&
          typeof parsed.joinCode === "string"
        ) {
          dispatch({
            type: "incoming_state",
            lobbyId: parsed.lobbyId,
            joinCode: parsed.joinCode,
            snapshot: parsed.snapshot as Snapshot,
          });
          return;
        }

        if (parsed.type === "ack" && typeof parsed.action === "string" && typeof parsed.tick === "number") {
          dispatch({
            type: "incoming_ack",
            action: parsed.action,
            tick: parsed.tick,
            lobbyId: typeof parsed.lobbyId === "string" ? parsed.lobbyId : null,
            entryCooldownSeconds:
              typeof parsed.entryCooldownSeconds === "number" ? parsed.entryCooldownSeconds : null,
          });
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

  const sendMatchAction = useCallback((actionType: ActionType) => {
    const currentState = stateRef.current;
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      dispatch({ type: "incoming_error", message: "Action failed: websocket is not connected." });
      return;
    }

    if (currentState.actionStates[actionType].status === "sending") {
      return;
    }

    dispatch({ type: "action_sent", actionType });
    socket.send(JSON.stringify({ type: actionType }));
  }, []);

  const startJoinFlow = useCallback((intent: JoinIntent) => {
    const socket = socketRef.current;
    const nextIdentity = identityRef.current;
    const currentState = stateRef.current;

    const entryCooldownRemainingSeconds = getEntryCooldownRemainingSeconds(currentState.entryCooldownEndsAtMs);
    if (entryCooldownRemainingSeconds > 0) {
      return;
    }

    if (!socket || socket.readyState !== WebSocket.OPEN) {
      dispatch({ type: "incoming_error", message: "Join failed: websocket is not connected." });
      return;
    }

    if (!nextIdentity) {
      dispatch({ type: "incoming_error", message: "Join failed: local identity is not ready." });
      return;
    }

    dispatch({
      type: "entry_join_requested",
      intent,
      entryAction: entryActionFromIntent(intent),
    });
    sendJoinIntentMessage(socket, intent, nextIdentity);
  }, []);

  const quickPlay = useCallback(() => {
    startJoinFlow({ kind: "quick_play" });
  }, [startJoinFlow]);

  const createLobby = useCallback(() => {
    startJoinFlow({ kind: "create_lobby" });
  }, [startJoinFlow]);

  const joinLobbyByCode = useCallback(
    (joinCode: string) => {
      const normalized = joinCode.trim().toUpperCase();
      if (!normalized) {
        dispatch({ type: "incoming_error", message: "Join code is required." });
        return;
      }

      startJoinFlow({ kind: "join_code", joinCode: normalized });
    },
    [startJoinFlow],
  );

  const leaveLobby = useCallback(() => {
    sendMatchAction("leave_lobby");
  }, [sendMatchAction]);

  const backToEntry = useCallback(() => {
    const currentState = stateRef.current;
    if (
      currentState.status === "connected" &&
      currentState.currentLobbyId &&
      currentState.session &&
      currentState.actionStates.leave_lobby.status !== "sending"
    ) {
      sendMatchAction("leave_lobby");
      return;
    }

    dispatch({ type: "go_entry" });
  }, [sendMatchAction]);

  const useNewPilotId = useCallback(() => {
    const nextIdentity: Identity = {
      id: crypto.randomUUID(),
      displayName: generateRandomDisplayName(),
    };

    if (typeof window !== "undefined") {
      localStorage.setItem(LOCAL_ID_KEY, nextIdentity.id);
      localStorage.setItem(LOCAL_NAME_KEY, nextIdentity.displayName);
    }

    identityRef.current = nextIdentity;
    setIdentity(nextIdentity);
    dispatch({ type: "identity_rotated", identity: nextIdentity });

    const currentState = stateRef.current;
    if (!currentState.identityResetRequired || !currentState.joinIntent) {
      return;
    }

    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }

    dispatch({
      type: "entry_join_requested",
      intent: currentState.joinIntent,
      entryAction: entryActionFromIntent(currentState.joinIntent),
    });
    sendJoinIntentMessage(socket, currentState.joinIntent, nextIdentity);
  }, [setIdentity]);

  return {
    state,
    sendMatchAction,
    quickPlay,
    createLobby,
    joinLobbyByCode,
    leaveLobby,
    backToEntry,
    useNewPilotId,
    dismissDetachedNotice: () => dispatch({ type: "clear_detached_notice" }),
    dismissJoinError: () => dispatch({ type: "clear_join_error" }),
  };
}

function StatusStrip({
  connectionStatus,
  reconnectAttempt,
  screen,
  phase,
  round,
  totalRounds,
  progressPercent,
  playerLabel,
  lobbyPlayerCount,
  targetLobbySize,
  factions,
  selfFactionId,
  currentLobbyId,
  currentJoinCode,
}: {
  connectionStatus: ConnectionStatus;
  reconnectAttempt: number;
  screen: AppScreen;
  phase: string;
  round: number;
  totalRounds: number;
  progressPercent: number;
  playerLabel: string;
  lobbyPlayerCount: number;
  targetLobbySize: number;
  factions: Array<{ id: number; label: string; playerCount: number; color: string }>;
  selfFactionId: number | null;
  currentLobbyId: string | null;
  currentJoinCode: string | null;
}) {
  const connectionClass =
    connectionStatus === "connected"
      ? "border-emerald-500/50 bg-emerald-600/20 text-emerald-200"
      : connectionStatus === "reconnecting"
        ? "border-amber-500/50 bg-amber-600/20 text-amber-200"
        : "border-slate-500/50 bg-slate-600/20 text-slate-200";

  const statusText =
    connectionStatus === "connected"
      ? "ONLINE"
      : connectionStatus === "reconnecting"
        ? `RETRY ${Math.max(1, reconnectAttempt)}`
        : connectionStatus === "connecting"
          ? "CONNECTING"
          : "OFFLINE";

  const progressLabel =
    screen === "entry_hub" || screen === "joining_lobby" || screen === "war_room_pre_match"
      ? `Lobby Fill ${lobbyPlayerCount}/${targetLobbySize}`
      : `${formatPhaseLabel(phase)} ${Math.max(round, 0)}/${totalRounds}`;

  return (
    <header className="rounded-2xl border border-slate-700/80 bg-slate-900/85 px-4 py-4 shadow-lg shadow-black/25 backdrop-blur">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Bannerfall</p>
        </div>

        <span className={`rounded-full border px-3 py-1 text-xs font-semibold uppercase tracking-wide ${connectionClass}`}>
          {statusText}
        </span>
      </div>

      <div className="mt-3 grid gap-2 sm:grid-cols-3">
        <MetricTile label="Player" value={playerLabel} compact />
        <MetricTile label="Faction" value={selfFactionId === null ? "No Faction" : factionLabel(selfFactionId)} compact />
      </div>

    </header>
  );
}

function EntryHub({
  connectionStatus,
  currentJoinCode,
  pendingEntryAction,
  entryCooldownRemainingSeconds,
  joinError,
  identityResetRequired,
  onQuickPlay,
  onCreateLobby,
  onJoinByCode,
  onUseNewPilotId,
  onDismissJoinError,
}: {
  connectionStatus: ConnectionStatus;
  currentJoinCode: string | null;
  pendingEntryAction: EntryAction | null;
  entryCooldownRemainingSeconds: number;
  joinError: { category: JoinErrorCategory; message: string } | null;
  identityResetRequired: boolean;
  onQuickPlay: () => void;
  onCreateLobby: () => void;
  onJoinByCode: (joinCode: string) => void;
  onUseNewPilotId: () => void;
  onDismissJoinError: () => void;
}) {
  const [joinCodeInput, setJoinCodeInput] = useState("");
  const isBusy = pendingEntryAction !== null;
  const isEntryCooldownActive = entryCooldownRemainingSeconds > 0;
  const blocked = connectionStatus !== "connected" || isBusy || isEntryCooldownActive;

  const quickPlayLabel =
    pendingEntryAction === "quick_play"
      ? "Joining..."
      : isEntryCooldownActive
        ? `Quick Play (${entryCooldownRemainingSeconds}s)`
        : "Quick Play";
  const createLobbyLabel =
    pendingEntryAction === "create_lobby"
      ? "Creating..."
      : isEntryCooldownActive
        ? `Create Lobby (${entryCooldownRemainingSeconds}s)`
        : "Create Lobby";
  const joinLabel =
    pendingEntryAction === "join_code"
      ? "Joining..."
      : isEntryCooldownActive
        ? `Join (${entryCooldownRemainingSeconds}s)`
        : "Join";

  return (
    <Panel title="Entry Hub" subtitle="Start a war room by quick play, create, or join code.">
      {/* {currentJoinCode ? (
        <div className="mb-3 rounded-lg border border-cyan-500/30 bg-cyan-900/20 px-3 py-2 text-xs text-cyan-100">
          Last lobby code: <span className="font-semibold">{currentJoinCode}</span>
        </div>
      ) : null} */}

      {joinError ? (
        <div className="mb-3 rounded-lg border border-rose-500/40 bg-rose-900/20 px-3 py-3 text-sm text-rose-100">
          <p className="font-semibold">{joinErrorTitle(joinError.category)}</p>
          <p className="mt-1">{joinError.message}</p>
          <p className="mt-1 text-xs text-rose-200">{joinErrorHint(joinError.category)}</p>
          <button
            type="button"
            onClick={onDismissJoinError}
            className="mt-2 rounded-md border border-rose-400/50 px-2 py-1 text-xs font-semibold uppercase tracking-wide"
          >
            Dismiss
          </button>
        </div>
      ) : null}

      <div className="grid gap-2 sm:grid-cols-2">
        <ActionButton
          label={quickPlayLabel}
          disabled={blocked}
          tone="attack"
          onClick={onQuickPlay}
        />
        <ActionButton
          label={createLobbyLabel}
          disabled={blocked}
          tone="burst"
          onClick={onCreateLobby}
        />
      </div>

      <div className="mt-3 rounded-xl border border-slate-700/80 bg-slate-950/50 p-3">
        <p className="text-xs uppercase tracking-wide text-slate-400">Join by Code</p>
        <div className="mt-2 flex gap-2">
          <input
            value={joinCodeInput}
            onChange={(event) => setJoinCodeInput(event.target.value.toUpperCase())}
            placeholder="ABC123"
            maxLength={8}
            className="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-slate-100 outline-none focus:border-cyan-500"
          />
          <button
            type="button"
            onClick={() => onJoinByCode(joinCodeInput)}
            disabled={blocked || joinCodeInput.trim().length === 0}
            className="rounded-lg border border-slate-500/60 bg-slate-700/30 px-3 py-2 text-sm font-semibold transition hover:bg-slate-600/40 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {joinLabel}
          </button>
        </div>
      </div>

      {/* {identityResetRequired ? (
        <div className="mt-3 rounded-lg border border-amber-500/40 bg-amber-900/20 px-3 py-3 text-sm text-amber-100">
          <p>Current pilot ID is blocked by lobby binding/cooldown.</p>
          <button
            type="button"
            onClick={onUseNewPilotId}
            className="mt-2 rounded-md border border-amber-400/60 bg-amber-700/20 px-3 py-1.5 text-xs font-semibold uppercase tracking-wide"
          >
            Use New Pilot ID
          </button>
        </div>
      ) : null} */}
    </Panel>
  );
}

function WarRoomView({
  snapshot,
  currentLobbyId,
  currentJoinCode,
  selfFactionId,
  factions,
  connectionStatus,
  actionStates,
  onAction,
  onLeaveLobby,
}: {
  snapshot: Snapshot | null;
  currentLobbyId: string | null;
  currentJoinCode: string | null;
  selfFactionId: number | null;
  factions: Array<{ id: number; label: string; hp: number; aliveCount: number; playerCount: number; color: string }>;
  connectionStatus: ConnectionStatus;
  actionStates: ActionStateMap;
  onAction: (action: ActionType) => void;
  onLeaveLobby: () => void;
}) {
  const lobbyCount = snapshot?.players.length ?? 0;
  const requestLeaveDisabled = connectionStatus !== "connected" || actionStates.request_leave.status === "sending";
  const cancelLeaveDisabled = connectionStatus !== "connected" || actionStates.cancel_leave.status === "sending";
  const leaveLobbyDisabled = connectionStatus !== "connected" || actionStates.leave_lobby.status === "sending";

  return (
    <Panel title="War Room" subtitle="Match starts exactly when 14 players are in lobby.">
      <div className="grid gap-3 sm:grid-cols-2">
        <MetricTile label="Join Code" value={currentJoinCode ?? "-"} />
        {/* <MetricTile label="Lobby ID" value={currentLobbyId ? currentLobbyId.slice(0, 12) : "-"} /> */}
        <MetricTile label="Lobby Fill" value={`${lobbyCount} / ${TARGET_LOBBY_SIZE}`} />
        <MetricTile label="Faction" value={selfFactionId === null ? "Awaiting Assignment" : factionLabel(selfFactionId)} />
      </div>

      <div className="mt-3 space-y-2">
        {factions.map((faction) => (
          <div key={faction.id} className="rounded-lg border border-slate-700/70 bg-slate-950/50 p-2.5">
            <div className="mb-1 flex items-center justify-between text-sm">
              <span>{faction.label}</span>
              <span className="font-semibold">{faction.playerCount} players</span>
            </div>
            <div className="h-2 w-full rounded-full bg-slate-800">
              <div
                className={`h-2 rounded-full ${faction.color}`}
                style={{
                  width: `${Math.min(
                    100,
                    Math.round((faction.playerCount / Math.max(Math.ceil(TARGET_LOBBY_SIZE / 2), 1)) * 100),
                  )}%`,
                }}
              />
            </div>
          </div>
        ))}
      </div>

      <div className="mt-4 grid gap-2 sm:grid-cols-3">
        {/* <ActionButton
          label={actionStates.request_leave.status === "sending" ? "Sending..." : "Request Leave"}
          disabled={requestLeaveDisabled}
          tone="neutral"
          onClick={() => onAction("request_leave")}
        /> */}
        {/* <ActionButton
          label={actionStates.cancel_leave.status === "sending" ? "Sending..." : "Cancel Leave"}
          disabled={cancelLeaveDisabled}
          tone="neutral"
          onClick={() => onAction("cancel_leave")}
        /> */}
        <ActionButton
          label={actionStates.leave_lobby.status === "sending" ? "Leaving..." : "Leave Lobby"}
          disabled={leaveLobbyDisabled}
          tone="attack"
          onClick={onLeaveLobby}
        />
      </div>

      <div className="mt-2 grid gap-1 text-xs text-slate-400 sm:grid-cols-3">
        <p>{statusMessage(actionStates.request_leave)}</p>
        <p>{statusMessage(actionStates.cancel_leave)}</p>
        <p>{statusMessage(actionStates.leave_lobby)}</p>
      </div>
    </Panel>
  );
}

function CombatView({
  selfPlayer,
  myFaction,
  factions,
  onLeaveLobby,
}: {
  selfPlayer: Snapshot["players"][number] | null;
  myFaction: Snapshot["factions"][number] | null;
  factions: Array<{ id: number; label: string; hp: number; aliveCount: number; playerCount: number; color: string }>;
  onLeaveLobby: () => void;
}) {
  return (
    <section className="space-y-3">
      <div className="flex items-center justify-end">
        <button
          type="button"
          onClick={onLeaveLobby}
          className="rounded-lg border border-rose-500/50 bg-rose-700/20 px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-rose-100 transition hover:bg-rose-600/30"
        >
          Leave Lobby
        </button>
      </div>
      <FactionHealthCard factions={factions} />
      <PlayerStatusCard player={selfPlayer} />
      <TeamBurstCard faction={myFaction} />
    </section>
  );
}

function SummaryView({
  summary,
  connectionStatus,
  round,
  totalRounds,
  reason,
  onBackToEntry,
  onUseNewPilotId,
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
  reason: string | null;
  onBackToEntry: () => void;
  onUseNewPilotId: () => void;
}) {
  return (
    <Panel title="Match Summary" subtitle="Outcome and contribution snapshot.">
      <div className="rounded-xl border border-emerald-600/40 bg-emerald-950/20 p-4">
        <p className="text-xs uppercase tracking-wide text-emerald-300">Winner</p>
        <p className="mt-1 text-2xl font-semibold text-emerald-100">{summary?.winnerLabel ?? "Pending"}</p>
        <p className="mt-1 text-sm text-emerald-200">
          Final round: {Math.max(round, 0)} / {totalRounds}
        </p>
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

      <div className="mt-4 rounded-lg border border-slate-700/70 bg-slate-950/50 px-3 py-2 text-sm text-slate-300">
        Match end reason: <span className="font-semibold text-slate-100">{formatMatchEndReason(reason)}</span>
      </div>

      <div className="mt-4 grid gap-2 sm:grid-cols-2">
        <ActionButton label="Back to Entry" disabled={false} tone="neutral" onClick={onBackToEntry} />
        <ActionButton label="Use New Pilot ID" disabled={false} tone="burst" onClick={onUseNewPilotId} />
      </div>

      <p className="mt-4 text-sm text-slate-300">
        {connectionStatus === "connected"
          ? "Ready for another lobby."
          : "Reconnect to receive real-time lobby updates."}
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
      <p className="mb-2 text-xs uppercase tracking-wide text-slate-400">Faction Health</p>
      <div className="space-y-2">
        {factions.map((faction) => (
          <div key={faction.id} className="rounded-lg border border-slate-700/70 bg-slate-950/50 p-2.5">
            <div className="mb-1 flex items-center justify-between text-sm">
              <span>{faction.label}</span>
              <span className="font-semibold">{Math.round(faction.hp)} HP</span>
            </div>
            <div className="h-2 w-full rounded-full bg-slate-800">
              <div
                className={`h-2 rounded-full ${faction.color}`}
                style={{ width: `${Math.max(0, Math.min(100, faction.hp / 90))}%` }}
              />
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
        <StatusLine label="Connection" value={player.connected ? "Connected" : "Disconnected"} />
        <StatusLine label="HP" value={String(Math.round(player.hp))} />
        <StatusLine label="Level / XP" value={`${player.level} / ${player.xp}`} />
        <StatusLine label="ATK" value={String(player.attackPower)} />
        <StatusLine label="Cooldown" value={`${player.cooldownRemaining}s`} />
        <StatusLine label="Exposed" value={player.isExposed ? "Yes" : "No"} />
        <StatusLine label="Kills / DMG" value={`${player.kills} / ${Math.round(player.damageDealt)}`} />
      </div>
    </div>
  );
}

function TeamBurstCard({ faction }: { faction: Snapshot["factions"][number] | null }) {
  const commitLabel =
    faction?.burstCommitCount === null || faction?.burstCommitCount === undefined
      ? "Hidden"
      : String(faction.burstCommitCount);

  return (
    <div className="rounded-xl border border-slate-700/80 bg-slate-950/40 p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-xs uppercase tracking-wide text-slate-400">Team Burst</p>
        <p className="text-xs font-semibold text-slate-200">{faction?.burstLocked ? "LOCKED" : "OPEN"}</p>
      </div>
      <p className="text-sm text-slate-200">
        Committers: <span className="font-semibold">{commitLabel}</span>
      </p>
      <p className="mt-1 text-xs text-slate-400">Enemy commit counts remain hidden by server snapshot rules.</p>
    </div>
  );
}

function EventFeed({ combatFeed, systemFeed }: { combatFeed: FeedItem[]; systemFeed: FeedItem[] }) {
  return (
    <Panel title="Event Feed" subtitle="Combat and system stream">
      <div className="space-y-4">
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

function NoticeBanner({ notice }: { notice: Notice }) {
  const className =
    notice.kind === "success"
      ? "border-emerald-500/40 bg-emerald-900/25 text-emerald-100"
      : notice.kind === "error"
        ? "border-rose-500/40 bg-rose-900/25 text-rose-100"
        : "border-sky-500/40 bg-sky-900/25 text-sky-100";

  return <div className={`mt-3 rounded-xl border px-4 py-3 text-sm ${className}`}>{notice.message}</div>;
}

function InlineInfoBanner({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <div className="mt-3 rounded-xl border border-cyan-500/40 bg-cyan-900/20 px-4 py-3 text-sm text-cyan-100">
      <div className="flex items-start justify-between gap-3">
        <p>{message}</p>
        <button
          type="button"
          onClick={onDismiss}
          className="rounded-md border border-cyan-400/60 px-2 py-1 text-xs font-semibold uppercase tracking-wide"
        >
          Hide
        </button>
      </div>
    </div>
  );
}

function Panel({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) {
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

function sendJoinIntentMessage(socket: WebSocket, intent: JoinIntent, identity: Identity): void {
  if (intent.kind === "create_lobby") {
    socket.send(JSON.stringify({ type: "create_lobby" }));
    return;
  }

  if (intent.kind === "quick_play") {
    socket.send(
      JSON.stringify({
        type: "join_lobby",
        joinCode: LEGACY_JOIN_CODE,
        playerId: identity.id,
        name: identity.displayName,
      }),
    );
    return;
  }

  if (intent.kind === "join_code") {
    socket.send(
      JSON.stringify({
        type: "join_lobby",
        joinCode: intent.joinCode,
        playerId: identity.id,
        name: identity.displayName,
      }),
    );
    return;
  }

  if (intent.lobbyId !== LEGACY_LOBBY_ID) {
    socket.send(
      JSON.stringify({
        type: "join_lobby",
        lobbyId: intent.lobbyId,
        playerId: identity.id,
        name: identity.displayName,
      }),
    );
    return;
  }

  socket.send(
    JSON.stringify({
      type: "join_lobby",
      joinCode: intent.joinCode ?? LEGACY_JOIN_CODE,
      playerId: identity.id,
      name: identity.displayName,
    }),
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
    leave_lobby: { status: "idle", message: null, tick: null },
  };
}

function useEntryCooldownRemainingSeconds(entryCooldownEndsAtMs: number | null): number {
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (entryCooldownEndsAtMs === null) {
      return;
    }

    setNowMs(Date.now());
    const timer = window.setInterval(() => {
      const currentNowMs = Date.now();
      setNowMs(currentNowMs);
      if (currentNowMs >= entryCooldownEndsAtMs) {
        window.clearInterval(timer);
      }
    }, 250);

    return () => {
      window.clearInterval(timer);
    };
  }, [entryCooldownEndsAtMs]);

  return getEntryCooldownRemainingSeconds(entryCooldownEndsAtMs, nowMs);
}

function getEntryCooldownRemainingSeconds(entryCooldownEndsAtMs: number | null, nowMs = Date.now()): number {
  if (entryCooldownEndsAtMs === null) {
    return 0;
  }

  const remainingMs = entryCooldownEndsAtMs - nowMs;
  if (remainingMs <= 0) {
    return 0;
  }

  return Math.ceil(remainingMs / 1000);
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
  if (action === "cancel_leave") {
    return "Leave cancel";
  }
  return "Leave lobby";
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

function entryActionFromIntent(intent: JoinIntent): EntryAction {
  if (intent.kind === "quick_play") {
    return "quick_play";
  }
  if (intent.kind === "create_lobby") {
    return "create_lobby";
  }
  return "join_code";
}

function classifyJoinError(message: string): JoinErrorCategory {
  const lower = message.toLowerCase();
  if (lower.includes("lobby not found")) {
    return "invalid_code";
  }
  if (lower.includes("lobby is full")) {
    return "lobby_full";
  }
  if (lower.includes("already bound to another lobby")) {
    return "bound_elsewhere";
  }
  if (lower.includes("rejoin cooldown active")) {
    return "rejoin_cooldown";
  }
  if (lower.includes("match already started")) {
    return "match_started";
  }
  return "generic";
}

function shouldOfferIdentityReset(category: JoinErrorCategory): boolean {
  return category === "bound_elsewhere" || category === "rejoin_cooldown";
}

function joinErrorTitle(category: JoinErrorCategory): string {
  if (category === "invalid_code") {
    return "Lobby code not found";
  }
  if (category === "lobby_full") {
    return "Lobby is full";
  }
  if (category === "bound_elsewhere") {
    return "Pilot already bound";
  }
  if (category === "rejoin_cooldown") {
    return "Rejoin cooldown active";
  }
  if (category === "match_started") {
    return "Match already started";
  }
  return "Join failed";
}

function joinErrorHint(category: JoinErrorCategory): string {
  if (category === "invalid_code") {
    return "Double-check the 6-character join code.";
  }
  if (category === "lobby_full") {
    return "Try another lobby or wait for slots to open.";
  }
  if (category === "bound_elsewhere") {
    return "Leave from the current lobby first, or switch to a new pilot ID.";
  }
  if (category === "rejoin_cooldown") {
    return "Wait for cooldown or switch to a new pilot ID.";
  }
  if (category === "match_started") {
    return "Join another lobby that has not started.";
  }
  return "Please retry.";
}

function extractMatchEndReason(payload: Record<string, unknown> | null): string | null {
  if (!payload) {
    return null;
  }

  const reason = payload.reason;
  return typeof reason === "string" ? reason : null;
}

function formatMatchEndReason(reason: string | null): string {
  if (!reason) {
    return "Unknown";
  }

  return reason.replaceAll("_", " ");
}

function buildDetachedNoticeMessage(previousLobbyId: string): string {
  return `If you try to leave before a match starts, it will take effect in 5s.`;
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

function screenLabel(screen: AppScreen): string {
  if (screen === "bootstrapping_identity") {
    return "Bootstrapping Identity";
  }
  if (screen === "socket_connecting") {
    return "Connecting";
  }
  if (screen === "entry_hub") {
    return "Entry Hub";
  }
  if (screen === "joining_lobby") {
    return "Joining Lobby";
  }
  if (screen === "war_room_pre_match") {
    return "War Room";
  }
  if (screen === "live_match") {
    return "Live Match";
  }
  return "Match Summary";
}
