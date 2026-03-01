/**
 * Placeholder payload for post-match settlement.
 * This stays stable while smart contract/ABI work is in progress.
 */
export interface MatchOutcomePayload {
  warId: string;
  winnerFactionId: number | null;
  finalFactionHp: [number, number];
  merkleRoot: string;
}

/** Result envelope for on-chain settlement attempts. */
export interface RecordOutcomeResult {
  submitted: boolean;
  txHash: string | null;
  reason: string;
}

/**
 * Stubbed settlement call.
 * Replace with ethers/contract invocation once Solidity + ABI are finalized.
 */
export async function recordOutcome(_payload: MatchOutcomePayload): Promise<RecordOutcomeResult> {
  return {
    submitted: false,
    txHash: null,
    reason: "On-chain integration is not wired yet.",
  };
}
