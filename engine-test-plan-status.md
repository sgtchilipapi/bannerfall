# Engine Test Plan Implementation Status

Source plan: `engine-test-plan.md`.

## Checklist

- [x] **Tooling script baseline exists (`test`, `test:watch`, `test:coverage`)**  
  Status: **Partial** — scripts are present, but `test:coverage` is a placeholder that exits with code 1.
- [ ] **Vitest configured and used for backend tests**  
  Status: **Not implemented** — backend tests use Node's built-in test runner (`node:test`) and no Vitest configuration exists.
- [x] **`density` unit suite**  
  Status: **Implemented** — cap, monotonicity, and invalid-input coverage are present in `density.test.ts`.
- [x] **`lobby` suite**  
  Status: **Implemented** — includes auto-balance, auto-start at max players, delayed leave/rejoin cooldown, and post-start join rejection.
- [x] **`phase` suite**  
  Status: **Implemented** — verifies prep/combat/transition timing, round increment, and round-limit end-state.
- [x] **`manual attack` suite**  
  Status: **Implemented** — covers combat-phase action gating, next-tick scheduling, cooldown enforcement, exposure-side effects, and faction-HP fallback when no targets are exposed.
- [x] **`burst` suite**  
  Status: **Implemented** — covers delayed cancel timing, 70% lock threshold behavior, lock-time cancellation rejection, and next-tick execution/reset semantics.
- [x] **`damage routing` suite**  
  Status: **Implemented** — covers newest-exposed-first targeting, overflow into faction HP, and density-scaled damage totals.
- [x] **`xp/level` suite**  
  Status: **Implemented** — covers +5 manual-landed XP, +2 kill XP, threshold leveling, and attack-power scaling/level-cap behavior.
- [x] **`snapshot visibility` suite**  
  Status: **Implemented** — verifies burst commit visibility is restricted to teammates and redacted for opponents/spectators.
- [x] **`win conditions` suite**  
  Status: **Implemented** — covers immediate faction-HP depletion, round-limit higher-HP winner selection, and round-limit tie handling in `backend/src/engine/win-conditions.test.ts`.
- [x] **`death/reset` suite**  
  Status: **Implemented** — covers death handling state transitions, dead-player action blocking, and per-round reset behavior that revives players while preserving level/faction HP.
- [x] **`server protocol` integration suite**  
  Status: **Implemented** — added websocket integration coverage for connect/join/state/action ack/error flows plus malformed-message handling in `backend/src/server-protocol.test.ts`.
- [x] **Server refactor for testability (`createServer()` / startup separation)**  
  Status: **Implemented** — websocket/engine/tick-loop wiring moved to `backend/src/createServer.ts`; `backend/src/server.ts` is now startup-only.
- [ ] **Deliverables: reusable test helpers**  
  Status: **Not implemented**.
- [ ] **Deliverables: CI-ready coverage target (`>=80%` on `engine/*`)**  
  Status: **Not implemented**.
- [ ] **Definition of done: all high-priority suites green, deterministic replay test, no flakes, one-command full run**  
  Status: **Not achieved**.

## Summary

Current implementation is **incomplete** relative to the test plan.

- Implemented plan suites: **11 / 11** (`density`, `lobby`, `phase`, `manual attack`, `burst`, `damage routing`, `xp/level`, `snapshot visibility`, `win conditions`, `death/reset`, `server protocol`).
- Core blockers:
  - Missing 2 planned deliverables (`reusable helpers`, `coverage target`).
  - Coverage command/target not configured.
  - Plan's Vitest tooling expectation not met.

Because the plan is not complete, full completion-gate test execution was **not triggered** in this status pass.
