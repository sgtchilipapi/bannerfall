/**
 * Core engine constants derived from MVP.md.
 * These values are centralized to keep simulation behavior deterministic.
 */

/** Authoritative server resolution (seconds per tick). */
export const TICK_SECONDS = 1;

/** Maximum lobby size (7v7). */
export const MAX_PLAYERS = 14;
/** Two opposing factions. */
export const FACTION_COUNT = 2;

/** Round timeline configuration. */
export const PREP_PHASE_SECONDS = 10;
export const COMBAT_PHASE_SECONDS = 45;
export const TRANSITION_SECONDS = 5;
export const TOTAL_ROUNDS = 5;

/** Base health and progression values. */
export const FACTION_HP_INITIAL = 9000;
export const PLAYER_HP_INITIAL = 100;
export const BASE_ATTACK_POWER = 25;
export const ATTACK_POWER_PER_LEVEL = 10;
export const MAX_LEVEL = 5;
export const ATTACK_COOLDOWN_SECONDS = 8;

/** Exposure windows for manual and burst actions before HP-threshold modifiers. */
export const MANUAL_EXPOSURE_BASE_SECONDS = 3; // 1 before + 1 during + 1 after
export const BURST_EXPOSURE_BASE_SECONDS = 5; // 3 before + 1 during + 1 after

/** Burst and lobby control timings. */
export const BURST_LOCK_RATIO = 0.7;
export const BURST_CANCEL_SECONDS = 3;
export const LOBBY_LEAVE_SECONDS = 5;
export const LOBBY_REJOIN_COOLDOWN_SECONDS = 5;

/** XP model from MVP (cumulative thresholds). */
export const XP_THRESHOLDS = [0, 5, 12, 22, 35] as const;
export const MANUAL_LANDED_XP = 5;
export const KILL_XP = 2;

/** Non-linear density curve parameters. */
export const DENSITY_CAP = 3.5;
export const DENSITY_CAP_RATIO = 5 / 7;
export const DENSITY_ALPHA = 1.4;
