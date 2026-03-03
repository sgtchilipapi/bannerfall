**Backend Automated Test Plan (MVP-first)**

1. **Test objective**
- Lock down deterministic MVP gameplay behavior in `backend/src/engine/warEngine.ts`, websocket behavior in `backend/src/server.ts`, and formula correctness in `backend/src/engine/density.ts`.

2. **Tooling and setup**
- Current suite already runs with Node's built-in test runner (`node:test`) against compiled output.
- Keep scripts in `backend/package.json`: `test`, `test:watch`, `test:coverage`.
- `vitest` is optional, not required for the current unit tests to run.
- If `vitest` is introduced later, existing tests would need migration from `node:test`/`node:assert` APIs to `vitest` globals (`test`, `expect`) or explicit compatibility imports.

3. **Test suites (priority order)**
1. `density` unit tests for cap, monotonicity, and edge inputs.
2. `lobby` tests for auto-balance, 14-player auto-start, leave delay, rejoin cooldown, join rejection post-start.
3. `phase` tests for prep/combat/transition timing and round progression.
4. `manual attack` tests for action gating, next-tick scheduling, cooldown, exposure application, faction HP fallback.
5. `burst` tests for commit/cancel timing, 70% lock threshold, lock immutability, next-tick execution.
6. `damage routing` tests for newest-exposed-first, overflow cascade, and density-scaled totals.
7. `xp/level` tests for +5 manual-landed XP, +2 kill XP, threshold leveling, AP scaling to max level.
8. `death/reset` tests for death handling, action blocking while dead, per-round resets with level/faction HP persistence.
9. `win conditions` tests for immediate faction HP depletion and round-5 HP comparison including tie behavior.
10. `snapshot visibility` tests ensuring burst commit counts are visible only to teammates.
11. `server protocol` integration tests for connect/join/state/action/ack/error and malformed message handling.

4. **Required refactor for testability**
- Move boot side effects out of `backend/src/server.ts` into a factory (example: `createServer()`), and keep `server.ts` as startup-only entrypoint. This enables clean integration tests without global port/timer conflicts.

5. **Deliverables**
- Test files under `backend/src/**/*.test.ts`.
- Reusable test helpers for creating players/matches and advancing ticks.
- CI-ready command: `npm run test`.
- Optional: wire real coverage reporting for `test:coverage` once a coverage tool is selected.

6. **Definition of done**
- All high-priority suites green locally.
- Deterministic replay test passes (same scripted actions => same final snapshot/logs).
- No known flaky tests.
- One command runs full backend tests successfully.
