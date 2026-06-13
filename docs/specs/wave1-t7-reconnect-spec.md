# T7 — Client resync + WebSocket reconnect robustness (executable spec)

**Status:** `Codex-reviewed 2026-06-13` (v1 findings folded; v2 confirmed APPROVED — false-
negative arming and TTFT/awaiting_confirmation false-positive holes closed by the unconditional
heartbeat; `setWebSocketAutoResponse` confirmed hibernation-safe). Ready for Codex Lane C to
implement against.
**Lane:** C. **Scope:** webapp + ONE isolated backend file (`user-event-hub.ts` heartbeat) —
file-disjoint from lanes A/B. **Owner:** Codex implements; Claude authored + reviews the diff.
**Plan:** `~/.claude/plans/wave1-wave2-batched-twoagent-execution.md` (D1; scope expanded to
include the server heartbeat per the 2026-06-13 decision).

## 1. Context — the prod incident this fixes

2026-06-13 prod talk `1343f8e1` round 22: a turn **completed on the backend**
(`talk_run_completed`/`talk_response_completed` durably in `event_outbox`) but the UI sat on
"Reconnecting / Running" ~5 min, composer locked, then recovered. Backend healthy throughout;
the client never learned the run ended. Seen twice in one session.

F9 (older): Cancel while UI shows "Running" but backend has no active run returns an error;
the error shows but the stale "Running" pill + locked composer persist.

## 2. Root cause (verified against code, v1 review corrected)

- **No liveness detection (primary).** Reconnect fires ONLY on an explicit ws `error`/`close`
  (`websocketEventSource.ts:97,102`). A half-open socket (sleep, network change, CF
  hibernation/proxy idle-kill) fires neither → client stays `'live'`, receives nothing, the
  run's terminal frames are pushed to a dead socket, nothing detects it until an unrelated
  close. Backoff is NOT the cause (caps at 8s, `talkStream.ts:296`).
- **Reconnect does NOT actually resync.** `onStateChange:'live'` only calls
  `scheduleInvalidateAllSnapshots()` + dispatches `STREAM_LIVE` (`useTalkRunStream.ts:317-324`)
  — it never calls `resyncTalkState()`. lastEventId IS preserved across reconnect
  (`talkStream.ts` replay-gap path), so there is no cursor bug; replay is the primary delivery,
  resync is the backstop.
- **Stale live entry survives resync (the pill bug).** `resyncTalkState()` →
  `MERGE_HISTORICAL_RUNS` updates `runsById` only and leaves `liveResponsesByRunId` untouched
  (`talkRunReducer.ts:437`); same-talk refetches skip re-hydration. So a run that went terminal
  during a gap keeps its live "Running" panel until some other event deletes it. Clearing it is
  a REQUIRED fix.
- **Cancel** surfaces the error but never reconciles (`useTalkComposerController.ts:572-592`).

## 3. Behavior 1 — heartbeat liveness (server + client)

Hibernation-friendly app-level ping/auto-pong. Sound regardless of run state (works between
runs AND during `awaiting_confirmation` — no run-state arming, no false positives).

**Server (`src/clawtalk/talks/user-event-hub.ts`, at accept ~:217):**
- After `state.acceptWebSocket(server, [topic])`, register an auto-response:
  `state.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG))` where
  `PING`/`PONG` are short constant strings (e.g. `"clawtalk:ping"` / `"clawtalk:pong"`). The CF
  runtime auto-replies to PING **without waking the DO** — zero hibernation cost.
- Add `setWebSocketAutoResponse` to the `DurableObjectState`-like interface (the file uses a
  narrowed local interface, ~:57-64) and to `WebSocketRequestResponsePair`. If the binding does
  not expose it, FALL BACK to an alarm-driven heartbeat (recurring ~20s alarm → send PONG-frame
  to all `state.getWebSockets()`), and note the DO-wake cost. Prefer auto-response.

**Client transport (`webapp/src/lib/websocketEventSource.ts`):**
- Add `send(data: string): void` to `WebSocketEventSourceLike` (:45) + the class (:49) →
  `ws.send(data)` (guard readyState).
- Filter inbound: if a message equals `PONG`, do NOT emit it as a frame — it is liveness only.

**Client (`webapp/src/lib/talkStream.ts`, in `openTalkStream` :298):**
- `HEARTBEAT_INTERVAL_MS = 20000`, `HEARTBEAT_TIMEOUT_MS = 50000` (≥ 2 intervals + slack).
- While `'live'`: every `HEARTBEAT_INTERVAL_MS`, `source.send(PING)`. Maintain a liveness timer
  reset on EVERY inbound message (frames AND PONG). If it reaches `HEARTBEAT_TIMEOUT_MS` with no
  inbound → treat socket dead → `closeSource()` + `scheduleReconnect()` (reuse the
  `handleTransportError` path). Clear both timers in `stop()`/`closeSource()`/on leaving `'live'`.
- This replaces the v1 run-state-armed watchdog entirely (which had false-negative arming — a
  half-open socket can't deliver the arming frames). Heartbeat is unconditional, so detection no
  longer depends on run state.

## 4. Behavior 2 — reconnect actually resyncs (`useTalkRunStream.ts:312`)

On `onStateChange:'live'` AFTER a reconnect (not the first mount-connect), also call
`resyncTalkState()` (debounced — collapse a replay backlog to one refetch), in addition to the
existing snapshot invalidation. Replay remains primary; this is the backstop that reconciles
terminal state the socket missed during the gap.

## 5. Behavior 3 — drop stale live entries on reconcile (`talkRunReducer.ts:437`) — REQUIRED

In `MERGE_HISTORICAL_RUNS` (and `SNAPSHOT_HYDRATED` :414 if applicable): for any run whose
refetched status is terminal (`completed`/`failed`/`cancelled`), DELETE its
`liveResponsesByRunId` entry. This is what actually clears the stale "Running" pill + unlocks
the composer after a resync. (Today the reducer leaves live entries untouched — the verified bug.)

## 6. Behavior 4 — cancel-contradiction resync (`useTalkComposerController.ts:583`)

In the `handleCancelRuns` catch (before/with `CANCEL_FAILED`): call `resyncTalkState()` on ANY
cancel failure (not just a specific code — a failure means the client's run view is suspect;
refetching truth is always safe). Combined with Behavior 3, a stale "Running" reconciles and the
composer unlocks. Keep showing the error message. Thread `resyncTalkState` into the
composer-controller the same way `useTalkRunStream` consumes it.

## 7. Test cases (deterministic — jsdom + vi.useFakeTimers; assert logic, never wall-clock)

talkStream.test.ts (extend FakeTransport; add a `send` spy + inbound-PONG support):
- T1: in `'live'`, a PING is sent every `HEARTBEAT_INTERVAL_MS`. (mutation: drop the ping loop → fails)
- T2: PONG inbound resets the liveness timer; with PONGs flowing, NO reconnect. (false-positive guard)
- T3: no inbound for `HEARTBEAT_TIMEOUT_MS` → transport closed + reconnect scheduled. (THE fix; mutation-verify)
- T4: a PONG message is NOT routed to frame callbacks (liveness only).
- T5: lastEventId preserved across the watchdog-driven reconnect (replay resumes forward).

talkRunReducer.test.ts:
- T6: `MERGE_HISTORICAL_RUNS` with a now-terminal run DELETES its `liveResponsesByRunId` entry
  (stale "Running" cleared). (mutation-verify — this is Behavior 3, the pill fix.)
- T7: a still-running run's live entry is preserved by `MERGE_HISTORICAL_RUNS` (no over-deletion).

useTalkRunStream / controller tests:
- T8: reconnect→'live' calls `resyncTalkState()` (debounced); first mount does not double-fire.
- T9: cancel failure invokes `resyncTalkState()` AND surfaces the error.

user-event-hub test (vitest; the file already has unit coverage):
- T10: `/upgrade` accept registers the ping/pong auto-response (assert `setWebSocketAutoResponse`
  called with the PING/PONG pair). If the alarm fallback is used instead, test that path.

## 8. Acceptance criteria
- Half-open socket is detected within ~`HEARTBEAT_TIMEOUT_MS` (~50s) regardless of run state →
  reconnect + replay + resync → terminal state applied, pill + composer reconcile. No 5-min stall.
- No reconnect while a healthy idle/`awaiting_confirmation` socket keeps ponging.
- Cancel failure reconciles run state.
- Heartbeat does not wake the DO (auto-response path) — confirm in review.
- All tests deterministic under fake timers; mutation-verify T3 + T6.
- `npm --prefix webapp run typecheck` + `test` green; backend `npm run test` green (hub test).

## 9. Shared constants
Define `PING`/`PONG`/intervals once and import on both sides (e.g. a small shared module or
mirror constants in client + hub with a comment linking them) so client and server never drift.

## 10. Out of scope
- Changing the DO replay window / retention / batch sizes.
- Reworking backoff (it is fine once liveness detection exists).
- Any lane A/B file (T4 caching, T5/T6) — disjoint.
```
