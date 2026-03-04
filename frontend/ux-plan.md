
Plan

Bannerfall MVP Smooth UX Plan (Frontend-first, Mobile-first)
Summary
Create a phase-based UX on the existing / page that maximizes action clarity for 1-second tick combat: clear state feedback, explicit action eligibility reasons, strong reconnect behavior, and low-friction mobile interaction.
This plan uses current backend protocol/state only (no required backend changes).

Skill usage: none (available skills are for Codex skill creation/installation, not product UX planning).

Ground Truth (from current repo)
Current UI is a single stacked dashboard in frontend/src/app/page.tsx.
Backend already sends enough data for smoother UX: ack, joined, state, error, player cooldown/exposure/alive/connected fields, burst lock info, and lobby leave actions in backend/src/createServer.ts.
Engine rules/targets are defined in MVP.md and include intended 7v7/14-player language.
Scope
In scope:
Frontend UX architecture and interaction behavior.
Mobile-first layout with desktop parity.
Moderate modularization of current page.
Task-time and error-based acceptance criteria.
Out of scope:
Backend gameplay logic changes.
DB/on-chain post-match flows.
New routes beyond / (use state-driven phase views inside one page).
Important Interface/Type Changes
No backend API contract changes required.
Frontend websocket type updates in frontend/src/app/page.tsx (or extracted types file):
Add ack envelope handling: { type: "ack"; action: string; tick: number }.
Keep joined envelope and persist faction/name context.
Expand Snapshot/EngineEvent typing to include existing backend fields already sent (started, payload, cooldownRemaining, isExposed, connected, burstLocked).
Add frontend config constant/env:
NEXT_PUBLIC_TARGET_LOBBY_SIZE default 14 for war-room copy and progress messaging.
UX Architecture (Phase-based Views)
Use one top-level view selector derived from snapshot:

war_room: !snapshot.started && !snapshot.ended
live_combat: snapshot.started && !snapshot.ended
match_summary: snapshot.ended
Always keep a persistent Top Status Strip:

Connection badge (connecting/connected/reconnecting).
Current phase + round.
Tick-synced countdown bar and seconds.
Personal identity compact display.
1. War Room View
Purpose: remove pre-match ambiguity and show readiness.
Elements:
Lobby progress card: currentPlayers / targetLobbySize.
Faction split card: live player counts by faction.
Personal status row: faction assignment + connection status.
Pre-match controls: Request Leave / Cancel Leave (using existing actions).
“What starts the war” helper copy (simple rule: match starts when lobby full).
Feedback:
Inline action toast from ack and error.
Reconnect banner while disconnected.
2. Live Combat View
Purpose: fast, obvious decisions every tick.
Elements:
Sticky action bar (bottom on mobile): Attack and Burst Commit/Cancel.
Explicit disabled reasons under buttons:
“Dead players cannot attack”
“Cooldown: Ns”
“Burst lock active” or “Not in combat phase”
Personal combat card:
HP/alive, level/xp, attack power, cooldown, exposed flag.
Team coordination card:
Teammates Ready X/Y with progress meter.
Burst lock/execution status when applicable.
Faction HP comparison card with clear leading side.
Event feed segmented:
Combat events first.
Errors and connection events visually distinct.
Feedback:
Action lifecycle states: idle -> sending -> acked or error.
Short success pulse on ack; persistent message on error.
Input lock while sending same action to prevent spam taps.
3. Match Summary View
Purpose: clear closure and outcome comprehension.
Elements:
Winner banner with final faction HP.
Personal contribution mini-stats (kills, damage, level/xp).
Match aggregate stats (alive/total, total kills/damage, final round).
“Waiting for next war room” status if server remains connected.
Mobile-first Layout Specification
Base layout (<640px):
Single-column cards.
Sticky top status strip + sticky bottom action bar.
Large tap targets (min-height: 44px).
Feed collapsed by default with “expand” control.
Tablet/desktop (>=768px):
Two-column content:
Left: core combat cards and controls.
Right: feed + secondary telemetry.
Keep top strip and improve scan density.
Motion:
Only meaningful transitions (phase change, ack pulse, reconnect banner slide).
Respect prefers-reduced-motion.
Frontend Refactor Plan (Moderate Modularization)
Extract client state and socket lifecycle to useMatchClient hook.
Split UI into components:
StatusStrip
WarRoomView
CombatView
SummaryView
ActionBar
EventFeed
FactionHealthCard
PlayerStatusCard
Keep a single source of truth reducer for connection/snapshot/feed/action-status.
Preserve deterministic rendering from server state; no client-authoritative timing.
Failure Modes and UX Handling
Socket disconnect:
Immediate reconnect banner + “actions temporarily unavailable”.
Auto-retry indicator with attempt count.
Invalid server payload:
Non-blocking error toast + keep last valid snapshot.
Action rejected:
Keep button enabled state synced to latest snapshot.
Show reason from server error text in inline alert area.
Stale/duplicate events:
Deduplicate by (tick,type,message) key in feed window.
Acceptance Criteria (Task-time + Errors)
New user on mobile can execute first valid combat action within 25s of entering combat.
Disabled action always shows a human-readable reason in 100% of blocked states.
Reconnect UX:
disconnect status visible within 1s of close event.
recovery to actionable connected state within <=7s median under normal local conditions.
Interaction errors:
invalid-action attempts reduced to <1 per 5 minutes in manual QA sessions.
Event readability:
user can correctly answer current phase/round/remaining time after 3 seconds glance in >=90% of trials.
Test Cases and Scenarios
First-load identity and auto-join:
Verify identity bootstrap and immediate status visibility.
Confirm join success updates faction and personal card.
War room interaction:
Trigger request_leave and cancel_leave.
Validate ack/error surfaces and button state transitions.
Combat action clarity:
During cooldown, Attack disabled with explicit timer reason.
While burst committed, manual attack reason is explicit.
On ack, action feedback pulse appears and clears.
Burst coordination:
Teammate-ready progress updates on each state snapshot.
Burst lock/execution states visibly transition without ambiguity.
Reconnect resilience:
Simulate socket close mid-combat.
Confirm reconnect banner, disabled actions, and auto-recovery.
Summary correctness:
On match end, winner and top stats match snapshot payload.
Responsiveness:
Validate mobile portrait baseline and desktop two-column behavior.
Confirm no overlap between sticky top/bottom bars and content.
Implementation Sequence
Define/centralize frontend protocol and snapshot types.
Build useMatchClient reducer/hook with ack handling and action lifecycle states.
Implement StatusStrip and phase-view switcher.
Implement WarRoomView with leave/cancel UX.
Implement CombatView with sticky action bar and explicit disabled reasons.
Implement SummaryView and event feed segmentation.
Add mobile-first layout polish and reduced-motion handling.
Run manual QA scenarios and score against acceptance criteria.
Assumptions and Defaults
Backend protocol remains as currently implemented; no schema additions required.
UX copy targets intended 14-player production behavior.
Frontend sets NEXT_PUBLIC_TARGET_LOBBY_SIZE=14 default for lobby messaging.
No new dependency is required; implement with React/Next/Tailwind currently present.
Single-page route retained; phase-based subviews are state-driven within that page.
