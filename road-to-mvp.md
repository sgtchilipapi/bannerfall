# Road to MVP Checklist

This checklist translates the recommended implementation path into practical, incremental milestones.

## Phase 1 — Backend Completion (Authoritative Tick Engine)

- [X] Confirm all gameplay constants match MVP values (tick rate, rounds, HP/AP/XP, cooldowns, burst threshold, density params).
- [X] Add server protocol integration tests for:
  - [X] `connected` envelope on websocket open
  - [X] `join` success/failure paths
  - [X] `state` request/response
  - [X] action `ack` for valid actions
  - [X] `error` handling for invalid actions
  - [X] malformed JSON handling
- [X] Add reusable backend test helpers:
  - [X] engine fixture setup
  - [X] websocket client test harness
  - [X] tick advancement utilities
- [X] Validate deterministic replay behavior (same scripted actions => same final snapshot/logs).
- [X] Ensure one-command backend validation stays green: `npm test`.

## Phase 2 — Frontend MVP Gameplay Shell (Thin, Functional UI)

- [X] Replace starter Next.js template page with MVP game screen.
- [X] Add local identity bootstrap on first load:
  - [X] generate UUID
  - [X] generate random display name
  - [X] store both in `localStorage`
- [X] Implement websocket client lifecycle:
  - [X] connect/disconnect handling
  - [X] auto-join payload using local identity
  - [X] incoming message reducer for state/events/errors
- [X] Build minimal playable HUD:
  - [X] phase, round, timer
  - [X] faction HP bars/values
  - [X] self panel (your stats + action availability)
- [X] Add combat controls:
  - [X] manual attack
  - [X] burst commit
  - [X] burst cancel
- [X] Add basic event/error feed on to the console log.
- [X] Add end-of-match summary view (winner + top-level stats).

## Phase 3 — Post-Match Persistence and Chain-Ready Interface

- [ ] Define and freeze match outcome payload shape:
  - [ ] player stats
  - [ ] damage log
  - [ ] burst events
  - [ ] final faction HP
  - [ ] war ID + merkle root
- [ ] Persist post-match data to DB.
- [ ] Implement deterministic hash + merkle root generation in backend.
- [ ] Store merkle root in DB for auditability.
- [ ] Keep on-chain submission behind a feature flag until Solidity contract/events are finalized.

## Phase 4 — Hardening, QA, and MVP Release Gate

- [ ] Run backend test suite and verify pass (`npm test`).
- [ ] Build frontend production bundle and smoke test.
- [ ] Execute multiplayer manual QA scenarios (2+ clients, target 14-player validation).
- [ ] Verify key edge cases:
  - [ ] burst threshold recalculates each tick
  - [ ] burst lock uses alive-at-lock semantics
  - [ ] dead players blocked from actions
  - [ ] round reset preserves level and faction HP
- [ ] Validate win conditions:
  - [ ] faction HP depletion
  - [ ] all enemy players dead simultaneously
  - [ ] round-5 faction HP comparison/tie behavior
- [ ] Document known limitations and post-MVP backlog.

## Suggested 7-Day Execution Plan

- [ ] **Day 1–2:** backend protocol tests + helpers
- [ ] **Day 3–4:** frontend playable shell
- [ ] **Day 5:** DB serialization + hash/merkle pipeline
- [ ] **Day 6:** end-to-end multiplayer test pass
- [ ] **Day 7:** bugfix, stabilization, release readiness checklist

## Implementation Guardrails

- [ ] Keep all authoritative game logic server-side.
- [ ] Do not introduce sub-second timers or client-authoritative timing.
- [ ] Keep frontend as a state-driven presentation/action layer over websocket.
- [ ] Avoid blocking MVP on full blockchain integration.
