# T-new-B — UserEventHub `blockConcurrencyWhile` overload fix

**Status:** Plan, **revised after Codex review (3 P1s addressed)**, awaiting eng review.
**Tracking:** Plan file `~/.claude/plans/currently-every-turn-of-iterative-marble.md` (T-new-B section).
**Branch (to be created):** `feature/t-new-b-user-event-hub-coalesce`.
**Estimated effort:** ~1 day human / ~3h CC.

### Revision history
- **2026-05-28 r1:** Initial plan. Approach: fire-and-forget drain from `handleNotify`, return 200 instantly.
- **2026-05-28 r2 (this version):** Codex `/codex review` flagged three P1s and six P2s on r1:
  - **P1-A:** `Promise.race([drainOnce, rejectAfter])` does not cancel `drainOnce`. The "exactly one drain in flight" claim was false — orphaned drains could overlap and race on cursors. **Fixed** by sequencing drain iterations on the actual `drainOnce` promise settling, not on the timeout race.
  - **P1-B:** Fire-and-forget durability under Cloudflare DO semantics is not guaranteed. **Fixed** by making `handleNotify` await the coalesced drain instead of returning instantly. Coalescing still eliminates the burst pile-up because all callers share one `drainInFlight` Promise; they don't each acquire their own `blockConcurrencyWhile`.
  - **P1-C:** Producer contract change from "drain attempted" to "flag set" was real. **Fixed** by P1-B's resolution — `handleNotify` still awaits drain before returning 200, preserving the current contract.
  - **P2 absorbed:** flag-race wording tightened (§4.3), alarm/upgrade starvation addressed via `MAX_DRAIN_ITERATIONS` cap (§4.2), measurement-before-fix instrumentation added (§4.5), Codex's missing-test list incorporated (§4.4), post-deploy `wrangler tail` gate explicit (§4.6).
  - **P2 deferred (Codex F9 — single drain might be slow):** Per-call `postgres.js` cold-connect in `withDoSql` may remain a cost center. Coalescing reduces *frequency* of cold connects but not per-call cost. Out of scope for this PR; tracked as a follow-up below.

---

## 1. Context — how we got here

### 1.1 The latency audit
2026-05-26: A full end-to-end audit of /chat → executor → UserEventHub DO → WebSocket → client identified 26 latency proposals (P0–P26). After `/plan-eng-review` (reduced scope to 11) and `/codex review` (D5–D10 reconciliation), the implementation order was locked: T9 (bench gate) → T0 / T2 → T4 / T5 / T6 → T8 → T7 → T1.

### 1.2 T9 baseline — what we measured
2026-05-27, `scripts/latency-bench.ts` against `https://clawtalk.app`, 3 runs × Haiku, SPA closed:

| Source | Plan estimate | **Measured** | Flag |
|---|---|---|---|
| `t1-t0` (POST /chat handler) | ~10–50 ms | **4603 ms** | 🚨 ~100× |
| `t3-t0` (TTFT to client) | 1500–7500 ms | **13729 ms** | 🚨 ~2× |
| Queue dispatch (POST /chat → consumer) | 0–5000 ms | **~5000 ms** | upper bound |

Two unexpected findings beyond the plan:

1. **`t1-t0 = 4.6s` is structural.** Tracked to per-request `postgres.js` client construction + ~9 sequential DB awaits in `enqueueTalkChat` (`src/clawtalk/web/routes/talks.ts:1910`). Added as proposal `T-new-A`.
2. **`UserEventHub` `blockConcurrencyWhile` resets.** With the SPA open during the dirty baseline, the DO repeatedly hit Cloudflare's 30s timeout and reset itself; `notify-queue gave up after retries` followed. This was masking 4/15 bench runs (failure as "event stream closed before completion"). Added as proposal `T-new-B`.

### 1.3 T0 — first attempt, no-op
PR #460 dropped `max_batch_timeout` from 5 → 0 (Codex F9 had warned this was a no-op with `max_batch_size=1`; the bench confirmed). Queue dispatch stayed at 5–14s. Negative result that ruled out the timeout config as the cause; pointed clearly at queue scheduling / cold consumer Worker spin-up as the real cost.

### 1.4 T7 — primary architectural fix
PR #463 (3 commits, including a Codex P1 fix on durability) added `dispatchRunInProcess`. For single-run `/chat` POSTs, the executor runs inline via `ctx.waitUntil` instead of going through `TALK_RUN_QUEUE`. Multi-run, cron, and job-run-now stay on the queue.

T7 measured savings:

| Metric | Pre-T7 clean | T7 prediction | **T7 measured** |
|---|---|---|---|
| `t1-t0` median | 4603 ms | unchanged | **4021 ms** ✓ |
| **`t3-t0` median** | **13729 ms** | 8000–9000 ms | **11014 ms** (−2715 ms, −20%) |
| Success rate | 3/3 | 3/3 | **3/3** ✓ |

Queue bypass confirmed via `wrangler tail` — zero `Queue clawtalk-talk-runs (1 message)` lines for bench runs.

### 1.5 Why T7 came in under prediction
The T7 verification run's tail showed:

```
(warn) waitUntil() tasks did not complete within the allowed time after invocation end and have been cancelled
POST http://hub/notify - Canceled @ ...
✘ Error: A call to blockConcurrencyWhile() in a Durable Object waited for too long. The call was canceled and the Durable Object was reset.
```

The DO reset and notify-queue cancellations **happened with the SPA closed**. The bench harness alone was enough to overload the DO. The hypothesis: the inline path emits notifies more densely than the queue path did. With the queue, the consumer Worker's cold-start added natural pacing; with T7, notifies fire tightly packed inside `ctx.waitUntil`. The DO's `blockConcurrencyWhile`-serialized notify path can't keep up with the burst, and queued notify calls accumulate past 30s.

**Conclusion:** T-new-B is no longer just a stability bug. It is the gating constraint for further T7-style wins. Until it lands, the inline executor's events will keep stalling on a DO that can't drain them fast enough.

---

## 2. The bug — what's actually slow in the DO

File: `src/clawtalk/talks/user-event-hub.ts` (476 lines).

Three handlers all use `state.blockConcurrencyWhile`:

| Handler | Line | What it does inside the block |
|---|---|---|
| `handleUpgrade` | 203 | Accept WebSocket + replay outbox window (≤500 frames, 5s timeout) |
| **`handleNotify`** | **317** | **Drain outbox → live sockets (8s timeout)** |
| `alarm` | 414 | Same drain as `handleNotify`, fires on backstop alarm |

`blockConcurrencyWhile` serializes all three handlers per DO instance. Cloudflare resets a DO if any single `blockConcurrencyWhile` call waits more than 30s to enter the lock.

### 2.1 What makes /notify expensive
Every `/notify` call does:

1. Acquire the per-DO lock.
2. Call `withDoSql` (`user-event-hub.ts:449`) — opens a **fresh `postgres.js` client** per call (`max: 1`, `fetch_types: true`, `prepare: false`, `connection.statement_timeout = '5000'`). The `fetch_types: true` flag costs one extra round trip on each cold connect to load Postgres type metadata.
3. Run `drainOnce`:
   - `getWebSockets()` and JWT expiry sweep.
   - Collect topics + minimum cursor across live sockets.
   - Loop: `getOutboxEventsForTopics(topics, cursor, 100)` → iterate rows → `ws.send(JSON.stringify(...))` → update each socket's serialized attachment cursor → break when rows < 100 or cap hit.
4. Close the `postgres.js` client.
5. `setAlarm(now + 30s)`.
6. Return 200.

Each notify therefore holds the lock for at minimum: postgres.js connect (~50–200 ms cold) + 1–N round-trip DB reads (~30–80 ms each) + WebSocket send loop (variable).

### 2.2 How a burst tips it over

During a single-run bench turn, the executor emits ~6–8 events (started, started_response, delta×N, completed, usage, run_completed). Each one triggers an `emitOutboxEventOutsideTx` → `enqueueStreamingNotify` → eventual `POST hub/notify` to the DO.

With T7, those notify POSTs land in a tighter burst because the inline path doesn't have the queue dispatch interval pacing them. Concurrent notifies queue on `blockConcurrencyWhile`. If 10 notifies each take ~3s in the lock (postgres cold-connect + drain), the 10th waits 27s, and by the time the 11th arrives, the 30s ceiling fires and the DO resets.

The reset cancels in-flight `ctx.waitUntil` notifies (visible in the tail as `POST http://hub/notify - Canceled`) and emits `notify-queue gave up after retries`. Events that the executor produced never reach the client; the bench harness sometimes sees `event stream closed before completion` (and pre-T7 dirty conditions had this 4/15 of the time).

### 2.3 What blockConcurrencyWhile actually protects on /notify

Re-reading `drainOnce` (lines 334–410): the only mutable state it touches that isn't already per-WebSocket is none. The cursor lives on the WebSocket attachment via `ws.deserializeAttachment` / `ws.serializeAttachment`. The risk of dropping `blockConcurrencyWhile` from `/notify` is that two concurrent drains could:

1. Both read `attachment.cursor = 5`.
2. Both fetch row with `event_id = 6` from outbox.
3. Both send row 6 to the same WebSocket and set `attachment.cursor = 6`.

Result: the client receives event 6 twice. This is a real concern. The fix has to either (a) keep serialization or (b) make drain idempotent against itself.

---

## 3. The fix — coalesce concurrent /notify calls onto a single shared drain (r2)

### 3.1 What we're changing
- **Concurrent `/notify` calls share one `drainInFlight: Promise<void>`.** The first caller starts the drain; subsequent callers `await` the same promise. All callers return 200 only after the shared drain settles.
- **`blockConcurrencyWhile` is called once per drain iteration**, not once per `/notify`. 10 concurrent notifies → 1 (or 2 if re-armed) `blockConcurrencyWhile` calls, not 10. This is what eliminates the burst pile-up.
- **Drain iterations are sequenced on the actual `drainOnce` promise settling**, not just on the `Promise.race` timeout. The 8s timeout still releases `blockConcurrencyWhile` early (so `handleUpgrade` and `alarm` aren't starved), but the do-while loop holds open until the orphaned `drainOnce` actually completes — preventing the two-concurrent-`drainOnce`-calls cursor race Codex flagged.
- **Re-arm flag (`drainRequested`) is set by notifies that arrive during an in-flight drain.** The outer loop re-runs at most `MAX_DRAIN_ITERATIONS` times (bounded to prevent starving `handleUpgrade` / `alarm`). Notifies past the cap rely on the alarm backstop.

### 3.2 Why this solves the observed problem
- **Eliminates the queue-of-30s-waiters.** No call to `blockConcurrencyWhile` ever has to wait behind 10 other `/notify` calls — there's only one outstanding `blockConcurrencyWhile` call per drain iteration.
- **Preserves the producer contract.** `flushNotifyQueueForOwner` still gets 200 only after a drain attempt completed (just possibly a *shared* drain attempt). Failure paths inside drain are still caught + logged + return 200, exactly as today. Codex P1-C resolved.
- **Eliminates the orphaned-`drainOnce` cursor race.** Each iteration waits for `drainOnce` to actually settle (not just for the `Promise.race` to resolve) before starting the next one. Codex P1-A resolved.
- **No fire-and-forget durability question.** `handleNotify` returns only after the shared drain (or a re-armed continuation) completes. CF DO unawaited-promise lifetime isn't load-bearing. Codex P1-B resolved.
- **Burst behavior:** 10 concurrent notifies → all await `drainInFlight` → 1 drain runs (~2–8 s under the lock + however long the orphaned `drainOnce` needs to truly finish, bounded by postgres `statement_timeout = 5000` per query) → all 10 return 200 simultaneously. If notifies arrived mid-drain, `drainRequested` is set, the loop runs one more iteration, all relevant callers return 200 then.

### 3.3 What we are NOT changing in this PR
- `withDoSql` per-call `postgres.js` client (Codex P2 F9). Coalescing reduces *frequency* of cold connects but not per-call cost. If post-deploy bench shows drain itself is still slow (sub-2s, not blockConcurrencyWhile wait), a follow-up PR pools the connection across drain iterations.
- `handleUpgrade` (line 203). Retains its existing `blockConcurrencyWhile` semantics. With `MAX_DRAIN_ITERATIONS` capping notify-driven drain pressure, it gets fair access between bursts.
- (Note: `alarm` IS changed per D2 — see §4.2 — to gain the orphan-await pattern for symmetry with the new `runDrainLoop`. Behavior is otherwise unchanged.)
- Outbox schema, replay semantics, retention window, JWT expiry sweep, backpressure handling, `DRAIN_BATCH_LIMIT = 100`, `DRAIN_TIMEOUT_MS = 8_000`, `ALARM_BACKOFF_MS = 30_000`, `BACKPRESSURE_BYTES = 1_000_000`. All unchanged.
- Producer side (`flushNotifyQueueForOwner`, retry policy, gave-up logging). Same code, same contract.

---

## 4. Implementation plan

### 4.1 Files modified

| File | Change |
|---|---|
| `src/clawtalk/talks/user-event-hub.ts` | Two new private fields, refactor `handleNotify`, new `scheduleDrain` method. No public API change. |
| `src/clawtalk/talks/user-event-hub.test.ts` | 3 new tests covering coalescing, in-flight return, and ordering under burst. |
| `docs/T-new-B-user-event-hub-fix.md` | This document (already created). |

No backend schema changes. No wrangler.toml changes. No new dependencies. No webapp changes.

### 4.2 The class change

Add two private fields and one constant to `UserEventHub` (near line 161, alongside `state` / `env`):

```ts
// Cap drain re-runs per notify burst. Notifies past the cap rely on
// the alarm backstop. Prevents drain monopolizing blockConcurrencyWhile
// under continuous notify pressure (Codex P2 — fairness vs handleUpgrade
// and alarm).
//
// Value is derived from the §4.5 measurement (per D1): ceil(p95
// burst depth / median rows per iteration) + 1. The default below is
// a placeholder — replace with the measured value before opening the
// PR. If measurement shows p95 burst depth ≤ 100 rows and median
// rows per iteration ≈ 100 (= DRAIN_BATCH_LIMIT), then 2 iterations
// cover p95 + 1 slack = 3. Keep the default at 3 only if measurement
// confirms it.
const MAX_DRAIN_ITERATIONS = 3;
```

```ts
// In the class body:
private drainInFlight: Promise<void> | null = null;
private drainRequested = false;
```

Replace `handleNotify` (current lines 316–332) with:

```ts
private async handleNotify(_req: Request): Promise<Response> {
  // Coalesce concurrent /notify calls onto one shared drain. All
  // callers AWAIT the same drainInFlight promise, so producer-side
  // contract is unchanged: 200 means a drain attempt that could have
  // included this notify's events has completed (modulo MAX_DRAIN_
  // ITERATIONS — past the cap, the alarm backstop catches up).
  await this.ensureDrain();
  // R4 backstop: alarm fires on idle and is a no-op if drain succeeded.
  await this.state.storage.setAlarm(Date.now() + ALARM_BACKOFF_MS);
  return new Response(null, { status: 200 });
}

private async ensureDrain(): Promise<void> {
  if (this.drainInFlight) {
    // Re-arm so the in-flight drain re-runs once more to pick up our
    // notification's events. We share the same Promise — when it
    // resolves, our /notify returns 200 too.
    this.drainRequested = true;
    return this.drainInFlight;
  }
  this.drainInFlight = this.runDrainLoop();
  try {
    await this.drainInFlight;
  } finally {
    // runDrainLoop's own finally nulls drainInFlight; defensive double-
    // clear if runDrainLoop itself threw before assigning null.
    this.drainInFlight = null;
  }
}

private async runDrainLoop(): Promise<void> {
  try {
    let iterations = 0;
    do {
      this.drainRequested = false;
      // Capture the actual drainOnce promise. Promise.race below
      // releases blockConcurrencyWhile early on timeout, but we still
      // need to await drainPromise to settle before the next iteration
      // so two concurrent drainOnce calls don't race on socket cursors
      // (Codex P1 finding — Promise.race does not cancel drainOnce).
      const drainPromise = this.drainOnce();
      await this.state.blockConcurrencyWhile(async () => {
        try {
          await Promise.race([
            drainPromise,
            rejectAfter(DRAIN_TIMEOUT_MS, 'drain_timeout'),
          ]);
        } catch (err) {
          console.error('[user-event-hub] drain failed', err);
        }
      });
      // CRITICAL: wait for the actual drainOnce to settle, even if
      // blockConcurrencyWhile released early on timeout. Otherwise the
      // next iteration starts a second drainOnce while the first is
      // still running, and they race on attachment.cursor writes.
      // postgres.js `statement_timeout = 5000` bounds individual queries,
      // so an orphaned drainOnce settles within a bounded window.
      await drainPromise.catch(() => {});
      iterations += 1;
    } while (this.drainRequested && iterations < MAX_DRAIN_ITERATIONS);
    // If drainRequested is still true at the cap, the alarm backstop
    // (set in handleNotify) catches up within ALARM_BACKOFF_MS.
  } finally {
    this.drainInFlight = null;
  }
}
```

**`alarm` is updated (D2 per /plan-eng-review)** to apply the same orphan-await pattern, eliminating the same Codex P1-A race in the alarm path:

```ts
async alarm(): Promise<void> {
  // The same Promise.race-doesn't-cancel issue Codex caught in
  // handleNotify also applies here: if drainOnce times out, an
  // orphaned drainOnce keeps running and could race with a
  // subsequent runDrainLoop iteration on attachment.cursor writes.
  // Await drainPromise.catch() outside blockConcurrencyWhile to
  // serialize against any concurrent drain.
  const drainPromise = this.drainOnce();
  await this.state.blockConcurrencyWhile(async () => {
    try {
      await Promise.race([
        drainPromise,
        rejectAfter(DRAIN_TIMEOUT_MS, 'alarm_drain_timeout'),
      ]);
    } catch (err) {
      console.error('[user-event-hub] alarm drain failed', err);
    }
  });
  // Ensure the orphaned drainOnce settles before alarm returns.
  await drainPromise.catch(() => {});
}
```

`handleUpgrade` is untouched.

### 4.3 Subtle correctness checks (r2)

1. **Flag race is safe — single isolate, single-threaded JS.** DO isolates run one task at a time. The window where `drainRequested` could be missed is between `this.drainRequested = false` (top of iteration) and the next `await`. Since `this.drainRequested = false` and the immediate following `const drainPromise = this.drainOnce()` happen synchronously, no other JS task can run between them. A notify that arrives during the same iteration's awaits sees `drainInFlight !== null`, sets `drainRequested = true`, and that flag is checked at the end of the iteration. Either the current iteration's drain already picked up the new event (because outbox was queried during the await), or the do-while re-runs and the next iteration picks it up.

2. **Two-`drainOnce`-call cursor race — resolved.** Each iteration sequences on `await drainPromise.catch(() => {})` before starting the next `drainOnce`. The Promise.race / `DRAIN_TIMEOUT_MS` is a soft signal that frees `blockConcurrencyWhile`, not a hard cancel of the underlying SQL/socket work. We hold the do-while loop open until `drainOnce` truly settles, so there is never more than one `drainOnce` executing.

3. **Ordering.** Drain still emits in `event_id` order (ascending). Coalescing N notifies onto M drain iterations does not violate ordering. The client's perception of order is unchanged.

4. **Failure handling.** If `drainOnce` throws inside `blockConcurrencyWhile`, the inner `catch (err)` swallows and logs (same as today). The outer `finally { drainInFlight = null }` clears state. If `drainPromise.catch(() => {})` swallows a timeout-orphaned error, that's intentional — the error was already logged in the inner catch. We do not need a top-level catch around the do-while.

5. **Alarm interaction.** Alarm fires every 30s as a backstop. With this change, alarm's drain typically finds zero new rows (the in-process drain already drained them). If the in-process drain failed or exited at the iteration cap with `drainRequested = true`, alarm catches up. Same eventual-consistency guarantee as today.

6. **`handleUpgrade` and `alarm` fairness.** `MAX_DRAIN_ITERATIONS = 3` caps how long a notify burst can hold `blockConcurrencyWhile`. Worst case: 3 iterations × (8s `blockConcurrencyWhile` budget + orphaned-`drainOnce` settling time bounded by `statement_timeout = 5000`) ≈ 39s of `blockConcurrencyWhile` lock occupancy in 3 separate slots. Each individual `blockConcurrencyWhile` call is ≤ 8s, so it cannot trigger CF's 30s reset. Upgrade and alarm calls that arrive during a drain burst wait at most ~13s for one slot to free (one iteration's `blockConcurrencyWhile` to release).

7. **CF DO unawaited-Promise lifetime — no longer load-bearing.** Because `handleNotify` awaits `drainInFlight` before returning 200, we never rely on workerd keeping an unawaited Promise alive past `fetch` return. Whatever CF does with unawaited Promises in DOs is irrelevant to this design.

### 4.4 Tests to add

File: `src/clawtalk/talks/user-event-hub.test.ts`.

The existing `FakeDurableObjectState` already serializes `blockConcurrencyWhile` calls via a chained-promise mutex (lines 81–119), tracks `blockConcurrencyWhileCalls` and `blockConcurrencyWhileMaxConcurrent`, and supports concurrent invocation. Six new test cases:

**Test 1 — coalescing reduces `blockConcurrencyWhile` calls.** Fire N concurrent `/notify` calls; assert `state.blockConcurrencyWhileCalls` after settlement is far less than N (≤ MAX_DRAIN_ITERATIONS + a small constant); assert all events reach the socket exactly once.

**Test 2 — flag re-arm.** Use a controlled-delay `drainOnce` stub to hold the first drain open; mid-drain, insert a second outbox row and fire a second `/notify`; release the first drain; assert the do-while loop runs a second iteration and the second event arrives at the socket.

**Test 3 — ordering under burst.** Insert 20 outbox rows; fire 10 parallel `/notify`; assert socket received events in `event_id` ascending order with no duplicates.

**Test 4 — `MAX_DRAIN_ITERATIONS` cap.** Stub `drainOnce` to always set `drainRequested = true` again (simulating continuous burst); assert the loop exits after `MAX_DRAIN_ITERATIONS`. Verifies the starvation cap actually fires.

**Test 4b — cap-then-alarm-recovery (D3 per /plan-eng-review).** Run Test 4's setup so the cap exits with `drainRequested = true` and outbox rows remain undrained. Advance simulated time; fire `alarm()` manually; assert the leftover outbox rows reach the socket and the cursor advances. Closes the "documented but not verified" gap — the doc relies on alarm catch-up, this test exercises it end-to-end.

**Test 5 — orphaned-`drainOnce` does not start a second `drainOnce`.** Stub `drainOnce` to hang for longer than `DRAIN_TIMEOUT_MS`; fire 2 sequential `/notify` calls (await the first, then fire the second); assert the second iteration's `drainOnce` does not start until the first's promise settles. Verifies the Codex P1-A fix.

**Test 6 — `handleNotify` awaits drain before returning 200.** Stub `drainOnce` with a controlled delay; fire `/notify`; assert the response Promise does not resolve until `drainOnce` resolves. Verifies the Codex P1-B/C fix (producer contract preserved).

**Test 7 — `alarm()` orphan-await pattern (D2 per /plan-eng-review).** Stub `drainOnce` to hang past `DRAIN_TIMEOUT_MS`; fire `alarm()`; assert that a subsequent notify-triggered `runDrainLoop` does not start a second `drainOnce` until the alarm's orphaned promise settles. Mirrors Test 5 but for the alarm path; closes the orphan-race symmetry gap.

The existing tests for replay window, alarm catch-up, JWT expiry, backpressure, F9 serialization stay valid — they cover paths we did not change. They should all continue to pass without modification.

### 4.5 Pre-implementation measurement step (added per Codex P2; expanded per D1)

Before writing the fix, instrument the *current* code on a branch and deploy temporarily to confirm the diagnosis with numbers, not just tail-log patterns:

1. Add `console.log` instrumentation to `handleNotify` capturing: timestamp, `blockConcurrencyWhile` wait time (measure as `Date.now()` before and after the `await this.state.blockConcurrencyWhile(...)` call), `drainOnce` duration, row count returned by `getOutboxEventsForTopics`, and POST-/notify body entries count.
2. Deploy to prod, re-run the haiku bench, capture tail.
3. Compute the following — these are the load-bearing values:
   - notify POST rate per turn (validates Codex P2 — burst mechanism)
   - median + p95 `blockConcurrencyWhile` wait time (validates the diagnosis: if wait > drain, this PR targets the right thing)
   - median + p95 `drainOnce` duration (informs whether postgres pooling follow-up is needed)
   - **burst depth = p95 number of `/notify` calls within `DRAIN_TIMEOUT_MS = 8s` window** (drives `MAX_DRAIN_ITERATIONS` selection per D1)
   - **median rows returned per `drainOnce` iteration** (also drives `MAX_DRAIN_ITERATIONS`)
4. Validate: is the bottleneck the *wait* (queue of /notify) or the *individual drain* (per-call postgres cold-connect)?
5. **Pick `MAX_DRAIN_ITERATIONS = ceil(p95_burst_depth / median_rows_per_iter) + 1.** Replace the placeholder default in §4.2. If measurement shows e.g. p95 burst depth = 250 events and median rows per iteration = 100, set the constant to `ceil(250/100) + 1 = 4`. The "+1" is slack for the iteration that re-arms drainRequested.
6. Revert the instrumentation, then ship the fix with the measured constant.

This adds ~45 min to the PR cycle (measurement deploy + revert) but eliminates two unmeasured assumptions: that the wait is the dominant cost (Codex F9), and that 3 is the right cap (D1).

### 4.6 Local verification before push

```bash
npm run typecheck                                  # backend tsc --noEmit
npx vitest run src/clawtalk/talks/user-event-hub.test.ts
npx vitest run                                      # full backend suite
npm run format:check
```

All four must pass before the PR opens.

### 4.7 Deploy + post-deploy verification

Same flow as T7 (PR #463):

1. Push branch, open PR, wait for CI green, squash-merge, watch deploy.
2. Two-terminal verification:
   - **Terminal 1:** `npx wrangler tail clawtalk --format=pretty`
   - **Terminal 2:** fresh `eb_at` + `npx tsx scripts/latency-bench.ts --provider=haiku`

**Expected results post-deploy (Codex P2 — concrete, falsifiable gate):**

| Metric | T7-only baseline | T-new-B prediction |
|---|---|---|
| `t1-t0` median | 4021 ms | unchanged (~4000 ms) |
| **`t3-t0` median** | **11014 ms** | **7500–9000 ms** (recovers the ~2–3s the DO contention added back to T7's measured win) |
| Success rate | 3/3 | 3/3 |
| `blockConcurrencyWhile` errors in tail across the run | several | **zero** |
| `POST http://hub/notify - Canceled` lines | several | **zero** |
| `notify-queue gave up after retries` | occasionally | **zero** |

**Tail-derived measurement (from the §4.5 instrumentation, if it's left in for the verification deploy):** record median `blockConcurrencyWhile` wait time; expect a drop from multi-second to sub-100ms.

If `t3-t0` stays at ~11 s with zero DO errors, the DO contention wasn't the gating latency constraint (it was the gating *stability* constraint); pivot to T-new-A as the next latency lever. The PR still ships for the stability win regardless of the latency outcome.

---

## 5. Risks and open questions (r2)

1. **Coalescing still preserves the producer contract**, but it changes *when* 200 is returned: before the fix, each `/notify` got 200 after its own drain attempt; after, 10 concurrent `/notify` calls all get 200 after the same shared drain attempt. From the producer's perspective (notify-queue), this is equivalent — it expects 200 to mean "drain attempted at least once that could have covered my event" and it gets exactly that.

2. **`MAX_DRAIN_ITERATIONS = 3` is the magic number to verify.** If a burst genuinely exceeds 3 iterations' worth of events, the 4th+ iteration is deferred to the alarm (worst case 30s catch-up). Default of 3 is a guess; the §4.5 measurement step should validate whether 3 is the right cap or whether 5 / 10 is better. Easy to tune post-merge if needed.

3. **Alarm storms.** Each `/notify` still calls `setAlarm`. Cloudflare deduplicates `setAlarm` to the latest value, so 10 concurrent calls = 1 effective alarm. Already true today; coalescing doesn't change it.

4. **Per-call `postgres.js` cold-connect (Codex P2 F9 — deferred).** If §4.5 measurement shows individual `drainOnce` calls are slow (>2s) due to cold connect rather than queue wait, this PR's coalescing helps less than predicted, but it still helps. A follow-up PR pools the connection across drain iterations within the DO's lifetime. Not load-bearing for this PR's diagnosis.

5. **Vitest can't validate CF DO production semantics (Codex P2 — explicit gate added).** Unit tests cover the coalescing logic, the iteration cap, the cursor-race fix, and the awaiting-drain contract. They do *not* validate `blockConcurrencyWhile`'s real 30s timeout behavior, DO eviction, or hibernation. Post-deploy bench + `wrangler tail` is the production gate. Plan accepts this; mitigation is the explicit success criteria in §4.7.

6. **What if `MAX_DRAIN_ITERATIONS` is too low under real load?** Symptom would be: events visibly delayed by ALARM_BACKOFF_MS (30s) for users sending many messages quickly. Easy to detect via bench p95 regression on long-burst scenarios. Bump the cap if observed.

7. **What if `MAX_DRAIN_ITERATIONS` is too high?** Symptom would be: `handleUpgrade` and `alarm` starvation under continuous notify pressure. Manifests as new WebSocket connects taking abnormally long, or alarm-driven catch-up failing to fire. Detectable via tail logs.

8. **What if T-new-B doesn't move `t3-t0` measurably?** Stability win still ships (no more `notify-queue gave up`). T-new-A becomes the next clear latency lever. The recalibrated plan already has T-new-A queued.

---

## 6. What lands in the PR

1. `src/clawtalk/talks/user-event-hub.ts` — two new private fields, one new constant (`MAX_DRAIN_ITERATIONS`, value derived from §4.5 measurement per D1), refactored `handleNotify`, new `ensureDrain` + `runDrainLoop` methods, **`alarm()` updated with the orphan-await pattern (D2 per /plan-eng-review)**. Net ~70 lines added, ~10 removed.
2. `src/clawtalk/talks/user-event-hub.test.ts` — eight new tests (coalescing, flag re-arm, ordering under burst, iteration cap, **cap-then-alarm-recovery (D3)**, orphan-`drainOnce` sequencing in handleNotify, awaiting-drain contract, **alarm orphan-await pattern (D2)**). Net ~200 lines added.
3. `docs/T-new-B-user-event-hub-fix.md` — this document (r2 after Codex + eng review).

**Sequencing:**
1. Branch off main, add §4.5 instrumentation, ship as a temp commit on the branch, deploy.
2. Run a measurement bench, capture the load-bearing values (blockConcurrencyWhile wait, drainOnce duration, burst depth, rows per iteration).
3. Compute `MAX_DRAIN_ITERATIONS` from the burst-depth + rows-per-iteration formula in §4.5 step 5.
4. Revert the instrumentation commit on the branch.
5. Apply the §4.2 + §4.4 changes with the measured constant.
6. Run local verification (§4.6).
7. Open PR, wait CI, merge, deploy, run §4.7 verification.

PR title: `perf(do): coalesce concurrent /notify calls onto a shared drain (T-new-B)`.

PR body includes:
- One-paragraph summary citing the T9 → T7 → T-new-B chain.
- The §4.7 success-criteria table.
- The measured `MAX_DRAIN_ITERATIONS` value with the formula that produced it.
- Reference to this doc.
- Note that the doc went through Codex Round 2 (3 P1s addressed) + /plan-eng-review (D1/D2/D3 addressed).

## 7. Worktree parallelization

**Sequential implementation, no parallelization opportunity.** The plan touches one source file (`user-event-hub.ts`) and one test file (`user-event-hub.test.ts`). The sequencing in §6 step 1–7 is inherently linear because step 2 (measurement) feeds step 5 (chosen constant).

## 8. Failure modes (new codepaths only)

| Codepath | Realistic failure mode | Test covers? | Error handling? | User visibility? |
|---|---|---|---|---|
| `runDrainLoop` outer try/finally | drainInFlight leak if both try and finally throw | No (V8 invariant: finally always runs) | Defensive `finally` in `ensureDrain` | Silent — alarm catches up |
| Iteration cap exit with drainRequested=true | Events sit ≤ ALARM_BACKOFF_MS (30s) before alarm fires | **Yes — Test 4b** | Alarm catch-up | User sees up to 30s event delay |
| Orphan `drainOnce` settling after blockConcurrencyWhile released | DB statement timeout fires; postgres.js closes connection | **Yes — Test 5** + Test 7 | Inner catch logs, outer continues | Silent — next iteration re-drains |
| Shared drainInFlight rejects mid-await | All concurrent /notify callers see same rejection | Implicitly via Test 6 (extend if needed) | Inner catch already swallows | All producers see 200 then; failure logged but not surfaced |

**Critical gaps** (no test AND no error handling AND silent): none. The orphan-`drainOnce` path settles via postgres `statement_timeout`; the alarm backstop covers iteration-cap exits; defensive `finally` covers the leak case.

## 9. Implementation Tasks

Synthesized from the findings above. Each task derives from a specific finding.

- [ ] **T1 (P1, human: ~45min / CC: ~10min)** — bench — Add `console.log` instrumentation to `handleNotify` per §4.5 step 1; ship as a temp commit on the branch and deploy.
  - Surfaced by: §4.5 (Codex P2 — diagnosis not yet verified with numbers)
  - Files: `src/clawtalk/talks/user-event-hub.ts`
  - Verify: deploy succeeds; tail shows instrumentation output during a haiku bench run.

- [ ] **T2 (P1, human: ~30min / CC: instant)** — measure — Run a haiku bench against the instrumented prod, compute the §4.5 step 3 values, derive `MAX_DRAIN_ITERATIONS` via §4.5 step 5 formula.
  - Surfaced by: D1 (calibrate the magic number) + Codex F9 (is the wait or the drain the cost?)
  - Files: none (measurement only)
  - Verify: produce a one-paragraph summary in the PR body with the four values + computed constant.

- [ ] **T3 (P1, human: ~5min / CC: ~2min)** — revert — Remove the §4.5 instrumentation commit from the branch.
  - Files: `src/clawtalk/talks/user-event-hub.ts`
  - Verify: `git log --oneline` shows the revert; instrumentation lines are gone.

- [ ] **T4 (P1, human: ~3h / CC: ~30min)** — DO — Apply the §4.2 class change: new `MAX_DRAIN_ITERATIONS` constant (with the measured value from T2), two new private fields, refactored `handleNotify` calling `ensureDrain` + `runDrainLoop`, **`alarm()` updated with the orphan-await pattern per D2**.
  - Surfaced by: Codex P1-A/B/C + D2
  - Files: `src/clawtalk/talks/user-event-hub.ts`
  - Verify: `npm run typecheck`; `npm run format:check`; module loads in vitest.

- [ ] **T5 (P1, human: ~3h / CC: ~45min)** — tests — Add the eight tests in §4.4 to `user-event-hub.test.ts`. Specifically: T1 coalescing, T2 flag re-arm, T3 ordering under burst, T4 iteration cap, **T4b cap-then-alarm-recovery per D3**, T5 orphan-`drainOnce` sequencing, T6 handleNotify awaits drain, **T7 alarm orphan-await pattern per D2**.
  - Surfaced by: §4.4 + D2 + D3
  - Files: `src/clawtalk/talks/user-event-hub.test.ts`
  - Verify: `npx vitest run src/clawtalk/talks/user-event-hub.test.ts` — all 8 new + existing pass.

- [ ] **T6 (P1, human: ~30min / CC: ~10min)** — verify — Push branch, wait CI green, squash-merge, watch deploy, run §4.7 two-terminal verification against prod.
  - Surfaced by: §4.7
  - Files: none (operational)
  - Verify: `wrangler tail` shows zero `blockConcurrencyWhile` errors AND zero `notify-queue gave up after retries` during a haiku bench; t3-t0 median lands in the §4.7 predicted range.

- [ ] **T7 (P2, human: ~10min / CC: ~5min)** — docs — After T6 verifies, add the measured numbers to the doc (r3 footer) with the actual t3-t0 delta and any deviation from prediction.
  - Surfaced by: continuous calibration
  - Files: `docs/T-new-B-user-event-hub-fix.md`
  - Verify: doc r3 includes the post-deploy reading.

---

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR (PLAN) | 3 issues found (D1 cap calibration, D2 alarm orphan-await, D3 cap-then-alarm test), 0 critical gaps; all 3 absorbed into r2.5 |
| Codex Review | `/codex review` | Independent 2nd opinion on plan | 1 | CLEAR (3 P1 fixed) | 3 P1 + 6 P2 in r1; all addressed in r2 (Promise.race-doesn't-cancel race, DO durability, producer contract) |
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | not run (infra fix, scope is self-evident) |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | not run (backend-only) |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | not run |

**CODEX:** 3 P1 + 6 P2 raised in r1; all reconciled in r2. P1-A (Promise.race-doesn't-cancel-drainOnce) fixed via `await drainPromise.catch()` outside `blockConcurrencyWhile`. P1-B (CF DO unawaited-Promise durability) fixed by making `handleNotify` await the shared `drainInFlight`. P1-C (producer contract change) fixed by the P1-B resolution. P2 items absorbed: §4.3 wording tightened, `MAX_DRAIN_ITERATIONS` cap added, §4.5 measurement step added, missing tests added, post-deploy `wrangler tail` gate explicit. F9 (single-drain-slow / postgres pool) explicitly deferred to a follow-up PR pending §4.5 measurement.

**ENG REVIEW (this run):** 3 substantive findings → 3 absorbed into r2.5. D1 binds `MAX_DRAIN_ITERATIONS` to the §4.5 measurement formula (replaces "guess of 3"). D2 applies the orphan-await pattern to `alarm()` for symmetry with `runDrainLoop` (closes the half-fixed-bug gap Codex's P1-A left in the alarm path). D3 adds Test 4b (cap-then-alarm-recovery) for the end-to-end backstop verification the doc relied on but didn't test.

**CROSS-MODEL:** Codex r1 and eng review found non-overlapping issues. Codex caught implementation correctness (Promise.race, durability, contract). Eng review caught engineering judgment (calibrate the cap, apply the fix symmetrically, test the recovery path). Two different lenses, both load-bearing.

**UNRESOLVED:** 0.

**VERDICT:** **CLEARED (with revised scope as r2.5)** — ready to implement following the T1–T7 sequence in §9. Critical constraints to remember during implementation:
1. T1 + T2 (measurement) MUST run before T4 so `MAX_DRAIN_ITERATIONS` lands as a measured value, not a placeholder.
2. T4 includes the `alarm()` refactor per D2, not just `handleNotify`.
3. T5 includes 8 tests (Tests 1–4, 4b, 5, 6, 7), not 6.
4. §4.7 post-deploy gate is the only validation of CF-DO-specific behavior; Vitest cannot cover it.

---

## r3 — 2026-05-28 (post-merge)

**Status: SHIPPED as PR #469 (merge commit `3902aed`) with scope narrowed from r2.5.**

### What §4.5 measurement actually showed

3 haiku turns vs instrumented prod, SPA closed, on the temp instrumentation deploy:

| Metric | Value |
|---|---|
| `bcwAcquireMs` p50 / p95 / max | **0 ms / 0 ms / 0 ms** |
| `drainMs` p50 / p95 | 416 ms / 464 ms |
| entries per `/notify` p50 | 1 |
| rows per `drainOnce` p50 / p95 | 2 / 4 (always exits at iter=0) |
| p95 burst depth in 8s window | 7 notifies |
| `blockConcurrencyWhile` errors in tail | 0 |
| `notify-queue gave up` | 0 |
| bench `t3-t0` median | 10855 ms (≈ T7 baseline 11014 ms) |

The 8s `rejectAfter` never fires in practice (drain p95 = 464 ms). The orphan-drainOnce race Codex caught is theoretical at the measured load. There is no lock-queue contention to coalesce.

§4.7's escape clause was triggered: ship for stability (correctness), not latency. Full coalesce was unnecessary — `blockConcurrencyWhile` already serializes correctly when nothing escapes the lock.

### Minimal fix that actually shipped (vs r2.5 plan)

| r2.5 element | r3 outcome |
|---|---|
| `drainInFlight` Promise sharing across handlers | **Not shipped** — no contention to coalesce |
| `MAX_DRAIN_ITERATIONS` on a do-while runDrainLoop | **Not shipped** — different mechanism added (`MAX_DRAIN_BATCHES_PER_CALL` bounds the inner batch loop instead) |
| `ensureDrain` + `runDrainLoop` methods | **Not shipped** |
| `handleNotify` awaits shared `drainInFlight` | **Not shipped** |
| `alarm()` orphan-await pattern (D2) | **Not shipped** — dropping `rejectAfter` removes the orphan entirely; alarm matches handleNotify by symmetry |
| 8 tests (Tests 1–4, 4b, 5, 6, 7) | **3 tests** — no-overlap × 2 + drain-cap × 1 |

Single source-file change in 3 PR commits:
- `59b288d` — drop `Promise.race([drainOnce(), rejectAfter(8s)])` from `handleNotify` and `alarm`. `drainOnce` now runs to completion inside `blockConcurrencyWhile`. Race becomes structurally impossible (BCWhile holds for full drainOnce; no second drainOnce can start until the first completes). Removed unused `DRAIN_TIMEOUT_MS` const.
- `c0b1477` — karpathy-audit follow-ups (comment trims, header docstring softened to acknowledge pathological-backlog risk).
- `7faf5fb` — codex `[P2]` follow-up: bound `drainOnce` outer batch loop with `MAX_DRAIN_BATCHES_PER_CALL = 10` (10 × ~500ms p95 = ~5s budget; 25s headroom under CF's 30s reset ceiling). Excess defers to the alarm backstop.

Net diff: `src/clawtalk/talks/user-event-hub.ts` (+37/−12), `src/clawtalk/talks/user-event-hub.test.ts` (+99/−1, 3 new tests).

### Post-deploy verification

3-haiku bench against the merged build, SPA closed, 2026-05-28 ~14:55 UTC:

| Metric | T7-only baseline | §4.7 prediction (r2.5) | r3 actual |
|---|---|---|---|
| `t1-t0` median | 4021 ms | unchanged | 4041 ms ✓ |
| `t3-t0` median | 11014 ms | 7500–9000 ms | **10720 ms** — matches T7, NOT improved |
| Success rate | 3/3 | 3/3 | 3/3 ✓ |
| `blockConcurrencyWhile` errors in tail | several | zero | **zero** ✓ |
| `notify-queue gave up` | occasionally | zero | **zero** ✓ |
| `MAX_DRAIN_BATCHES_PER_CALL` warn fires | n/a | n/a | zero (drains stayed at 1 iter) |

Stability predictions hit; latency prediction missed exactly as §4.5 forecast. Next latency lever is T-new-A (POST /chat handler structural cost, t1-t0 = 4.2s).

### Reviews that ran on the diff

- **karpathy-audit** (style lens): 0 critical, 2 warning, 3 nit. All absorbed in `c0b1477`. Notably flagged the same pathological-backlog risk codex caught — cross-model agreement.
- **codex review** (behavior lens): 0 `[P1]`, 1 `[P2]` (bound the drain inside BCWhile). Absorbed in `7faf5fb`. Validates [[feedback-codex-catches-behavior-karpathy-catches-style]] once more: codex caught the fix-it-in-code finding karpathy could only flag as a doc softening.

### Follow-ups deferred to separate PRs

- **postgres.js cold-connect (Codex F9)** — drainMs p95 = 464ms is mostly cold-connect cost. Pool the postgres client across drains within DO lifetime. Worth ~300ms per drain.
- **T-new-A: POST /chat handler latency** — t1-t0 = 4.2s structural (per-request postgres client + ~9 sequential awaits in `enqueueTalkChat`). Bigger latency lever; on the recalibrated plan.

### Process notes worth keeping

- The §4.5 measurement step saved a 70-line refactor. Without it, we would have shipped `drainInFlight` coalescing + `MAX_DRAIN_ITERATIONS` cap chasing a contention that doesn't currently exist. Generalizable: for any DO/concurrency/perf plan, deploy instrumentation and measure BEFORE locking the code design.
- karpathy + codex both fired on the same architectural risk via different lenses (style → docstring softening; behavior → code fix). The two-lens rule held: neither alone would have caught it.

