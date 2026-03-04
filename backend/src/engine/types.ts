/** Fixed faction identifiers for this 2-team MVP. */
export type FactionId = 0 | 1;
/** Lifecycle phases of a match instance. */
export type MatchPhase = "waiting" | "prep" | "combat" | "transition" | "ended";
/** Action categories that can resolve as damage. */
export type AttackKind = "manual" | "burst";
/** Burst lifecycle markers for telemetry/output. */
export type BurstStage = "locked" | "executed";

/** Full authoritative player state tracked by the engine. */
export interface PlayerState {
  /** Stable player id (provided by client or generated server-side). */
  id: string;
  /** Display name shown in snapshots/events. */
  name: string;
  /** Team assignment. */
  factionId: FactionId;
  /** XP-derived level, 1..5. */
  level: number;
  /** Cumulative XP used for level-up checks. */
  xp: number;
  /** Current HP for this round. */
  hp: number;
  /** Current attack power (derived from level). */
  attackPower: number;
  /** Remaining seconds until attack actions are available (manual or burst execution). */
  cooldownRemaining: number;
  /** Whether damage routes to this player first when exposed. */
  isExposed: boolean;
  /** Remaining exposure duration in ticks/seconds. */
  exposureRemaining: number;
  /** Round-local alive flag. */
  isAlive: boolean;
  /** Burst commitment toggle status. */
  isCommittedToBurst: boolean;
  /** Tick at which burst commitment happened. */
  burstCommitTimestamp: number | null;
  /** Tick when cancel should finalize (if requested). */
  pendingBurstCancelTick: number | null;
  /** Tick when lobby leave should finalize (pre-match only). */
  pendingLobbyLeaveTick: number | null;
  /** Tick used for newest-first exposed target ordering. */
  exposureAppliedTick: number;
  /** Match-wide kill count. */
  kills: number;
  /** Match-wide death count. */
  deaths: number;
  /** Match-wide damage contribution. */
  damageDealt: number;
  /** Transport-level connection flag (player can exist while disconnected). */
  connected: boolean;
}

/** Authoritative per-faction state. */
export interface FactionState {
  /** Faction identifier. */
  id: FactionId;
  /** Member player ids. */
  players: string[];
  /** Persistent HP across all rounds. */
  factionHp: number;
  /** Committed player ids for the current burst cycle. */
  burstCommits: string[];
  /** Whether burst has crossed threshold and is now immutable. */
  burstLocked: boolean;
  /** Tick when burst damage should execute. */
  burstScheduledTick: number | null;
  /** Alive count snapshot captured at lock time (for telemetry/auditing). */
  burstLockedAliveCount: number | null;
}

/** Attack queued for deterministic future resolution. */
export interface ScheduledAttack {
  /** Attack source kind. */
  kind: AttackKind;
  /** Attacking player id. */
  attackerId: string;
  /** Attacking faction id. */
  attackerFactionId: FactionId;
  /** Target faction id. */
  targetFactionId: FactionId;
  /** Exact tick when this attack resolves. */
  resolveTick: number;
  /** Attack power captured at queue time. */
  attackPower: number;
}

/** Per-hit record for post-match analytics/proofs. */
export interface DamageLogEntry {
  tick: number;
  kind: AttackKind;
  attackerId: string;
  attackerFactionId: FactionId;
  targetFactionId: FactionId;
  rawDamage: number;
  multiplier: number;
  totalDamage: number;
  damageToPlayers: number;
  damageToFaction: number;
  hitExposedPlayers: boolean;
}

/** Burst lock/execute telemetry item. */
export interface BurstEvent {
  tick: number;
  factionId: FactionId;
  stage: BurstStage;
  committedAtStage: number;
}

/** Human-readable event stream emitted during ticks. */
export interface EngineEvent {
  tick: number;
  type: string;
  message: string;
  payload: Record<string, unknown> | null;
}

/** Full authoritative match state container. */
export interface MatchState {
  tick: number;
  started: boolean;
  ended: boolean;
  phase: MatchPhase;
  phaseRemaining: number;
  round: number;
  winnerFactionId: FactionId | null;
  players: Record<string, PlayerState>;
  factions: [FactionState, FactionState];
  scheduledAttacks: ScheduledAttack[];
  damageLog: DamageLogEntry[];
  burstEvents: BurstEvent[];
  events: EngineEvent[];
}

/** Standard command result envelope. */
export interface ActionResult {
  ok: boolean;
  error: string | null;
}

/** Result for lobby join attempts. */
export interface JoinResult extends ActionResult {
  playerId: string | null;
  factionId: FactionId | null;
}

/** Faction view sent to clients (with teammate-only burst commit counts). */
export interface PublicFactionView {
  id: FactionId;
  factionHp: number;
  playerCount: number;
  aliveCount: number;
  burstLocked: boolean;
  burstCommitCount: number | null;
}

/** Player view sent to clients (with visibility restrictions by faction). */
export interface PublicPlayerView {
  id: string;
  name: string;
  factionId: FactionId;
  level: number;
  xp: number;
  hp: number;
  isAlive: boolean;
  isExposed: boolean;
  cooldownRemaining: number;
  kills: number;
  deaths: number;
  damageDealt: number;
  attackPower: number;
  connected: boolean;
  isCommittedToBurst: boolean | null;
}

/** Snapshot payload broadcast over websocket. */
export interface PublicSnapshot {
  tick: number;
  started: boolean;
  ended: boolean;
  phase: MatchPhase;
  phaseRemaining: number;
  round: number;
  totalRounds: number;
  winnerFactionId: FactionId | null;
  selfPlayerId: string | null;
  selfFactionId: FactionId | null;
  factions: [PublicFactionView, PublicFactionView];
  players: PublicPlayerView[];
  events: EngineEvent[];
}
