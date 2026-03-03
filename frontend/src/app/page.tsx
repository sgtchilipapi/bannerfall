"use client";

import { useEffect, useMemo, useReducer, useState } from "react";

const LOCAL_ID_KEY = "bannerfall.player.id";
const LOCAL_NAME_KEY = "bannerfall.player.displayName";
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

type FeedItem = {
  kind: "event" | "error";
  message: string;
  tick?: number;
};

type EngineEvent = {
  tick: number;
  type: string;
  message: string;
};

type Snapshot = {
  tick: number;
  ended: boolean;
  phase: string;
  phaseRemaining: number;
  round: number;
  totalRounds: number;
  winnerFactionId: number | null;
  factions: { id: number; factionHp: number }[];
  players: {
    id: string;
    factionId: number;
    isAlive: boolean;
    kills: number;
    damageDealt: number;
  }[];
  events: EngineEvent[];
};

type WsEnvelope =
  | { type: "connected"; tickSeconds: number }
  | { type: "joined"; playerId: string; factionId: number; name: string }
  | { type: "state"; snapshot: Snapshot }
  | { type: "error"; message: string }
  | { type: string; [key: string]: unknown };

type ConnectionStatus = "connecting" | "connected" | "disconnected";

type ClientState = {
  status: ConnectionStatus;
  tickSeconds: number;
  snapshot: Snapshot | null;
  feed: FeedItem[];
  processedEventCount: number;
};

type ClientAction =
  | { type: "socket_connecting" }
  | { type: "socket_connected"; tickSeconds: number }
  | { type: "socket_disconnected"; message: string }
  | { type: "incoming_state"; snapshot: Snapshot }
  | { type: "incoming_error"; message: string }
  | { type: "incoming_event"; event: EngineEvent };

const initialClientState: ClientState = {
  status: "connecting",
  tickSeconds: 1,
  snapshot: null,
  feed: [],
  processedEventCount: 0,
};

function clientReducer(state: ClientState, action: ClientAction): ClientState {
  if (action.type === "socket_connecting") {
    return { ...state, status: "connecting" };
  }

  if (action.type === "socket_connected") {
    return { ...state, status: "connected", tickSeconds: action.tickSeconds };
  }

  if (action.type === "socket_disconnected") {
    return {
      ...state,
      status: "disconnected",
      feed: [{ kind: "error", message: action.message }, ...state.feed].slice(0, MAX_FEED_ITEMS),
    };
  }

  if (action.type === "incoming_state") {
    const newEvents = action.snapshot.events.slice(state.processedEventCount);
    const nextFeed = [...state.feed];

    for (const event of newEvents) {
      nextFeed.unshift({ kind: "event", message: event.message, tick: event.tick });
    }

    return {
      ...state,
      snapshot: action.snapshot,
      feed: nextFeed.slice(0, MAX_FEED_ITEMS),
      processedEventCount: action.snapshot.events.length,
    };
  }

  if (action.type === "incoming_error") {
    return {
      ...state,
      feed: [{ kind: "error", message: action.message }, ...state.feed].slice(0, MAX_FEED_ITEMS),
    };
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
  const [clientState, dispatch] = useReducer(clientReducer, initialClientState);

  useEffect(() => {
    if (!identity) {
      return;
    }

    dispatch({ type: "socket_connecting" });

    const wsUrl = process.env.NEXT_PUBLIC_WS_URL ?? "ws://127.0.0.1:8080";
    const socket = new WebSocket(wsUrl);

    socket.addEventListener("message", (raw) => {
      const parsed = parseEnvelope(raw.data);
      if (!parsed) {
        dispatch({ type: "incoming_error", message: "Received invalid server payload." });
        return;
      }

      if (parsed.type === "connected") {
        dispatch({ type: "socket_connected", tickSeconds: parsed.tickSeconds });
        socket.send(JSON.stringify({ type: "join", playerId: identity.id, name: identity.displayName }));
        return;
      }

      if (parsed.type === "state") {
        dispatch({ type: "incoming_state", snapshot: parsed.snapshot });
        return;
      }

      if (parsed.type === "error") {
        dispatch({ type: "incoming_error", message: parsed.message });
      }
    });

    socket.addEventListener("close", () => {
      dispatch({ type: "socket_disconnected", message: "Connection lost. Refresh to reconnect." });
    });

    socket.addEventListener("error", () => {
      dispatch({ type: "incoming_error", message: "Unable to reach websocket server." });
    });

    return () => {
      socket.close();
    };
  }, [identity]);

  const match = clientState.snapshot
    ? {
        phase: clientState.snapshot.phase,
        round: clientState.snapshot.round,
        totalRounds: clientState.snapshot.totalRounds,
        secondsRemaining: clientState.snapshot.phaseRemaining,
        totalSeconds: Math.max(clientState.tickSeconds * 15, 1),
      }
    : fallbackMatch;

  const factionHealth = useMemo(() => {
    if (!clientState.snapshot) {
      return [
        { label: "Red Faction", value: 0, color: "bg-rose-500" },
        { label: "Blue Faction", value: 0, color: "bg-sky-500" },
      ];
    }

    return [
      {
        label: "Red Faction",
        value: clientState.snapshot.factions.find((faction) => faction.id === 0)?.factionHp ?? 0,
        color: "bg-rose-500",
      },
      {
        label: "Blue Faction",
        value: clientState.snapshot.factions.find((faction) => faction.id === 1)?.factionHp ?? 0,
        color: "bg-sky-500",
      },
    ];
  }, [clientState.snapshot]);

  const timeRemainingPercent = Math.min(100, Math.max(0, Math.round((match.secondsRemaining / match.totalSeconds) * 100)));

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
      winnerLabel,
      totalPlayers,
      alivePlayers,
      totalKills,
      totalDamage,
    };
  }, [clientState.snapshot]);

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

function bootstrapIdentity() {
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

function generateRandomDisplayName() {
  const adjectives = ["Swift", "Iron", "Silent", "Ember", "Noble", "Arcane"];
  const nouns = ["Falcon", "Warden", "Ranger", "Vanguard", "Sentinel", "Drifter"];

  const adjective = adjectives[Math.floor(Math.random() * adjectives.length)];
  const noun = nouns[Math.floor(Math.random() * nouns.length)];
  const suffix = Math.floor(100 + Math.random() * 900);

  return `${adjective}${noun}${suffix}`;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-slate-700 bg-slate-950/40 p-3">
      <p className="text-xs uppercase tracking-wide text-slate-400">{label}</p>
      <p className="mt-1 text-lg font-semibold">{value}</p>
    </div>
  );
}

function Bar({ label, value, color }: { label: string; value: number; color: string }) {
  const clampedValue = Math.min(100, Math.max(0, value));

  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-sm">
        <span>{label}</span>
        <span>{value}%</span>
      </div>
      <div className="h-2 w-full rounded-full bg-slate-800">
        <div className={`h-2 rounded-full ${color}`} style={{ width: `${clampedValue}%` }} />
      </div>
    </div>
  );
}
