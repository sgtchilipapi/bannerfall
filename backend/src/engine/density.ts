import { DENSITY_ALPHA, DENSITY_CAP, DENSITY_CAP_RATIO } from "./constants.js";

/**
 * Applies the MVP density curve.
 *
 * - `attackers / aliveTeamSize` determines pressure ratio for this faction on the tick.
 * - Ratio at or above cap ratio returns hard cap.
 * - Otherwise returns non-linear scaling between 1x and cap using alpha exponent.
 */
export function densityMultiplier(attackers: number, aliveTeamSize: number): number {
  // Defensive fallback: if no valid attackers/team size, resolve at baseline multiplier.
  if (attackers <= 0 || aliveTeamSize <= 0) {
    return 1;
  }

  const ratio = attackers / aliveTeamSize;
  if (ratio >= DENSITY_CAP_RATIO) {
    return DENSITY_CAP;
  }

  const normalized = ratio / DENSITY_CAP_RATIO;
  return 1 + Math.pow(normalized, DENSITY_ALPHA) * (DENSITY_CAP - 1);
}
