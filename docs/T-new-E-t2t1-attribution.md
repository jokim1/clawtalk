# T-new-E — t2-t1 attribution (measurement-only plan)

**Status:** Plan, **r2 draft**.
**Tracking:** [[project-llm-turn-latency]].
**Branch (planning):** `docs/t-new-e-t2t1-attribution` (this doc).
**Branch (implementation, to be created):** `feature/t-new-e-instrumentation`.
**Estimated effort:** ~2 h human / ~1 h CC for instrumentation + bench. Follow-up plans (T-new-E1, E2, ...) handle the fixes.

---

## 1. Context

Post-T-new-C bench (n=3, haiku, single-agent, 2026-05-30) per-phase
breakdown — the surprise:

| Phase | Median | What it covers |
|---|---|---|
| t1-t0 | 3038 ms | HTTP `POST /chat` → 202 returned. **Optimized by T-new-A/A2/AR/C.** |
| **t2-t1** | **6571 ms** | **HTTP 202 returned → first `talk_response_started` WS event arrives at client. Untouched.** |
| t3-t2 | 709 ms | First WS event → first `talk_response_delta` (model TTFT-ish). |
| t4-t3 | 1 ms | First delta → completion (bench prompt is short, single emit). |

**t2-t1 is the largest single phase in the entire path** —
~2× t1-t0 and >6× t3-t2 — and no prior T-new lever has touched it.
What lives in t2-t1 is in §2.

This plan is **measurement-only**. Per
[[feedback-measure-before-locking-perf-plans]] the rule is: for a
~6.5 sec structural-unknown phase, deploy temp instrumentation +
measure prod BEFORE locking a fix design. T-new-E delivers the
attribution table; T-new-E1/E2/... pick up the dominant phase
and ship the lever(s).

---

## 2. Surface inventory — what runs in t2-t1

Pinned against current origin/main `696302d`. Path from `ctx.waitUntil(dispatchRunInProcess(...))` firing to the first `talk_response_started` event landing at the bench client. **Cost estimates are priors only**, not measurement (§3 is what gives the real numbers).

| Phase | Code | Likely cost |
|---|---|---|
| E0 | `ctx.waitUntil` schedules `dispatchRunInProcess` (worker-app.ts:~2382) | scheduling delay (~ms) |
| E1 | `withRequestScopedDb` opens a fresh DB scope (`dispatch-in-process.ts:55`) | Hyperdrive cold-connect possible (~50-300 ms) |
| E2 | `processTalkRunMessage` retry-emit branch (queue-consumer.ts:99-117) | 0 ms on first attempt (skipped) |
| E3 | `markRunRunning(runId)` (queue-consumer.ts:119) | 1 DB write (~125 ms) |
| E4 | `withUserContext` open (queue-consumer.ts:153) | **3 stmts: BEGIN + `set local role authenticated` + `select set_config(...)` for the JWT claim** (codex P2-F caught this — not 1 stmt). |
| E5 | `getTalkMessageById(trigger_message_id)` (queue-consumer.ts:163) | 1 DB read (~125 ms) |
| E6 | Cancel-poller setup (queue-consumer.ts:173-193) | sync (~ms) |
| E7 | `CleanTalkExecutor.execute(input, signal, emit)` entry | wrapper, ~0 ms |
| E8 | `getTalkRunById(input.runId)` (new-executor.ts:2383) | 1 DB read |
| E9 | `loadChannelTriggerContext({ triggerMessageId })` (new-executor.ts:2388) | DB reads (channel routing) |
| E10 | `resolveTalkAgent(talkId, targetAgentId)` (new-executor.ts:2392) | DB reads (agent + nickname) |
| E11 | `ensureRunnableModel(activeAgent)` (new-executor.ts:2404) | possibly model-lookup |
| E12 | `getModelContextWindow(activeAgent)` (new-executor.ts:2405) | possibly model-lookup |
| E13 | `buildTalkJobExecutionPolicy(input.jobId)` (new-executor.ts:2406) | DB read if jobId, else 0 |
| E14 | `planExecution(agent, requestedBy, planOpts)` (new-executor.ts:2414) | Effective-tools graph — codex C2 prior: ~435 ms/agent. |
| E15 | `loadChannelExecutionContext({ trigger, binding })` (new-executor.ts:2423) | DB reads |
| E16 | `loadTalkContext(talkId, ...)` (new-executor.ts:2443) | **Many DB reads (message history, threads, tools, content) — likely the fattest single phase.** |
| E17 | Prompt assembly (system + user) | sync (~ms-100 ms) |
| E18 | **Direct-path pre-LLM prep:** attachment DB reads + history attachment hydration + `buildDirectHistoryMessages` (new-executor.ts:2630) + PDF/page prep + PDF diagnostics + edit-intent checks + possible content-edit emits. **Was conflated with E19 in r1 (codex P1-A).** | Unknown — may be hundreds of ms. |
| E19 | `executeWithAgent(...)` call (new-executor.ts:2766) → LLM streaming connection open → provider emits 'started' | LLM connect (~50-300 ms typical) |
| E20 | Mapper produces `talk_response_started` (new-executor.ts:233) → fire-and-forget `emit(...)` at queue-consumer.ts:212 → `emitOutboxEventOutsideTx(...)` → INSERT into event_outbox + notify push | **emit() returns instantly (codex P1-B).** Actual outbox INSERT + notify push happen async; instrument inside `outbox-emit.ts:79` and `streaming-notify.ts` to capture. |
| E21 | UserEventHub DO drain → WebSocket frame → client receipt (= t2 on the client) | **NOT directly observable from Worker logs (codex P1-C).** T-new-B prior: ~50-500 ms drain p95. Treated as a derived residual in §4. |

Per [[feedback-verify-schema-facts-in-plan-gates]]: file + line numbers round-tripped through grep against `696302d`.

### 2.1 Why this phase is unmeasured today

T7 inline executor SHIPPED 2026-05-27 (PR #463) replaced the queue dispatch with `ctx.waitUntil(dispatchRunInProcess(...))`. T7 measured t3-t0 (integrated) and got a 2.7 sec drop but did NOT publish a per-phase breakdown of what was left. T-new-B (DO drain fix) measured drainMs but not the upstream warmup chain. So we know t2-t1 is 6.5 sec today but not **which** phase inside the chain dominates.

Static-analysis suspects (priors): **E16 `loadTalkContext`** (biggest DB surface), **E14 `planExecution`** (codex C2 prior ~435 ms), **E18 direct-path prep** (codex P1-A surfaced this — newly suspect after r1 missed it), **E10 `resolveTalkAgent`** (2-3 RTs).

---

## 3. Instrumentation strategy

Add temp `[t-new-e-meta]` probes at each E-phase boundary in **four files** (codex P1-B caught r1's mistake of only probing the emit call site, which is fire-and-forget):

1. **dispatch-in-process.ts + queue-consumer.ts + new-executor.ts** — E0-E19 phase boundaries with `Date.now()` deltas tagged with `runId` + phase ID.
2. **outbox-emit.ts:79** (`emitOutboxEventOutsideTx`) and **streaming-notify.ts** — instrument the actual INSERT + notify push, keyed by `runId` extracted from the payload (or by `eventId` once available). Captures E20's real timing rather than the misleading 0 ms at the fire-and-forget call site.

```ts
// Standard phase probe:
const tEx = Date.now();
const result = await someAwait(...);
console.log('[t-new-e-meta]', { phase: 'Ex:label', runId, ms: Date.now() - tEx, stmts: getWireCount() - stmtsBeforeEx });
```

**Wire-statement counter (extended scope per codex P2-E).** Proxy-wrap **three** SQL accessors, not just `getDbPg()`:
- `getDbPg()` — covers tx-scoped and request-scoped reads
- `getOutOfBandSql()` — covers `outbox-emit.ts`'s streaming-emit path (separate connection sibling to the tx)
- The `withUserContext` internal `BEGIN + set local role + set_config(...)` triplet — count as 3 stmts on E4, not 1 (codex P2-F).

Increment a per-request counter on each tagged-template call. Logged alongside `ms` per phase so we can distinguish "this phase is slow because many DB reads" from "this phase is slow because one slow read" from "this phase is slow because Hyperdrive cold-connected".

**Pre-deploy verification (karpathy W2):** before pushing the instrumentation commit, `grep -n 'ctx.waitUntil.*dispatchRunInProcess' src/clawtalk/web/worker-app.ts` to confirm the T7 inline path is still wired for single-run /chat. If a recent PR rerouted single-run /chat to the queue path, the bench measures the queue and the attribution is meaningless. Skip the deploy if the grep returns 0 hits.

**waitUntil hazard tracking (codex P2-D):** CF Workers' `ctx.waitUntil` has a 30 sec cap shared across all `waitUntil` calls for a request; slow/canceled tails can disappear from the sample. Track in each bench run:
- Were `[t-new-e-meta]` entries observed at every E-phase, or did the trail stop mid-chain?
- Did `dispatchRunInProcess` log its fallback line (`falling back to TALK_RUN_QUEUE.send`)?
- Did the run row reach a terminal status (`completed`/`failed`/`cancelled`) within the bench's wait?
- Was a `talk_response_started` event observed in the bench client?

Any run that fails any of the above is excluded from the attribution medians and noted in the table.

**Deploy shape (codex P2-H + karpathy W3):**
- **Single-purpose instrumentation commit** on `feature/t-new-e-instrumentation` off main. Tag its SHA in the plan when committed.
- Push, wait for deploy.
- Run **two cohorts** (codex P2-G):
  - **Cold cohort:** n=5 with a `sleep 60` between runs so the Worker isolate has time to evict.
  - **Warm cohort:** n=10 back-to-back, no sleep.
- Read `[t-new-e-meta]` entries from `wrangler tail` filtered on `[t-new-e-meta]`. Collect per-phase ms + stmts into the §4 attribution table.
- **Revert commit** on the same branch (pure code revert, no doc changes — single-purpose). Tag the revert SHA.
- Verify `git diff origin/main -- src/` is empty.
- Deploy the reverted build (so prod has no instrumentation).
- THEN open the PR with: instrumentation commit + revert commit + doc commit. Reviewer sees a clear three-commit story; prod is unchanged.

**Bandwidth note (karpathy W1).** CF Workers tail has a sustained rate limit (\~50 req/s of log entries before drops). Each bench run emits ~22 `[t-new-e-meta]` entries (E0-E20 + outbox probes); 15 total runs (5 cold + 10 warm) over ~5 min = ~330 entries / 300s = ~1 entry/s. Well under quota. Joseph as solo user means total log volume stays under quota even with normal traffic. If `wrangler tail` reports drops, fall back to CF dashboard's structured log search.

---

## 4. Attribution output (T-new-E deliverable)

After the bench runs (cold + warm cohorts), the two tables below fill in. Once filled, the PR ships with the instrumentation commit + the revert commit + this filled table as the docs change.

**Cold cohort (n=5, 60 sec gap between runs):**

```
| Phase | p50 ms | p90 ms | stmts | Notes |
|---|---|---|---|---|
| E1 withRequestScopedDb | ? | ? | 0 | Hyperdrive cold-connect dominates here |
| E3 markRunRunning | ? | ? | 1 | |
| E4 withUserContext open | ? | ? | 3 | BEGIN + set role + set_config |
| E5 getTalkMessageById | ? | ? | 1 | |
| E8 getTalkRunById | ? | ? | 1 | |
| E9 loadChannelTriggerContext | ? | ? | ? | |
| E10 resolveTalkAgent | ? | ? | ? | |
| E11 ensureRunnableModel | ? | ? | ? | |
| E12 getModelContextWindow | ? | ? | ? | |
| E13 buildTalkJobExecutionPolicy | ? | ? | ? | |
| E14 planExecution | ? | ? | ? | codex C2 prior: ~435 ms |
| E15 loadChannelExecutionContext | ? | ? | ? | |
| E16 loadTalkContext | ? | ? | ? | suspect: fattest single phase |
| E17 prompt assembly | ? | ? | 0 | sync |
| E18 direct-path pre-LLM prep | ? | ? | ? | codex P1-A: attachment + history + PDF prep |
| E19 executeWithAgent → LLM connect → 'started' | ? | ? | 0 | provider-side |
| E20 outbox INSERT + notify push (probed in outbox-emit.ts) | ? | ? | 1 | |
| **Worker subtotal** | **?** | **?** | **?** | Sum E1..E20 |
| **E21 DO + WS + client receipt (residual)** | bench t2-t1 - Worker subtotal | derived | n/a | not directly observable from Worker logs (codex P1-C); bounded by T-new-B's ~50-500 ms drain p95 |
| **Bench t2-t1** | (observed) | (observed) | n/a | from latency-bench.ts |
```

**Warm cohort (n=10, back-to-back):** same shape. Differences from cold attribute to Hyperdrive cold-connect (E1) and isolate startup.

**Reconciliation rule:** Worker subtotal + E21 residual should equal bench t2-t1 ± 5 %. A residual outside the ~500 ms upper bound (T-new-B's drain p95) signals either a missed phase or a measurement bug — re-instrument.

After the tables are filled, the **dominant phase becomes the next T-new-E1 plan target**. If no single phase dominates and the cost is distributed (e.g., E10 + E14 + E16 each at ~1 sec), T-new-E1 may be a multi-phase plan.

**Cold-vs-warm comparison** also signals separate levers: if Hyperdrive cold-connect (E1) is multi-second on cold runs but ~0 on warm, the lever is "warm the connection earlier" or "pool more aggressively" — a different plan than "the executor warmup chain is slow".

---

## 5. Risks and correctness

| Risk | Mitigation |
|---|---|
| Instrumentation overhead skews measurements | `Date.now()` deltas are ~µs cost; `console.log` is sync but small. Compared to a 6.5 sec phase, noise is < 1 %. |
| Probes fire on non-bench user requests | Joseph as solo user → total log volume stays under CF tail quota even with normal traffic. |
| Proxy wrap on the SQL accessors breaks something | Same pattern used in [[T-new-C-ensure-default-agent]] Test 2. Extended scope here covers `getDbPg`, `getOutOfBandSql`, and a withUserContext-setup hook. Proven harmless. |
| Revert step forgotten → instrumentation ships to prod | §3 deploy shape mandates revert before PR opens; `git diff origin/main -- src/` must be empty (codex P2-H). Single-purpose instrumentation commit isolates the change. |
| Bench doesn't trigger the inline path (falls back to queue) | Pre-deploy grep verifies `ctx.waitUntil.*dispatchRunInProcess` is still wired in worker-app.ts (karpathy W2). Also tail for `falling back to TALK_RUN_QUEUE.send` log lines (dispatch-in-process.ts:79) during the bench. |
| `ctx.waitUntil` 30 sec cap silently truncates the inline path | Codex P2-D: track per-run signal completeness — every run must produce probes at every E-phase AND a terminal run status. Runs missing the full trail are excluded from medians and called out in the table (could indicate the lever target is "the chain is so slow it sometimes hits the 30 sec cap"). |
| Client clock skew vs Worker clock | Do not subtract client-side `Date.now()` from Worker-side `Date.now()` (codex P1-C). All instrumented timestamps are Worker-side; client-observed t2 enters the table only as the bench's integrated t2-t1, which is compared to the sum, not individual phase deltas. |
| n=10 too thin for p90 | Codex P2-G: split into cold (n=5) + warm (n=10) cohorts; p90 is triage-grade, not decisive. If two phases are within 10 % of each other, run a follow-up n=30 warm cohort to discriminate. |

---

## 6. Tasks

| Task | Files | Verify |
|---|---|---|
| **E-D0** Pre-deploy grep verifies T7 inline path is still wired (karpathy W2) | `grep ctx.waitUntil.*dispatchRunInProcess src/clawtalk/web/worker-app.ts` | non-zero hits |
| **E-D1** Add `[t-new-e-meta]` probes to dispatch-in-process.ts + queue-consumer.ts + new-executor.ts + outbox-emit.ts + streaming-notify.ts (5 files) + Proxy-wrap for `getDbPg`/`getOutOfBandSql`/withUserContext setup | 5 src files | typecheck passes |
| **E-D2** Single-purpose commit on `feature/t-new-e-instrumentation`; record commit SHA in this plan | n/a | one commit, src-only |
| **E-D3** Push; deploy succeeds; confirm logs visible via `wrangler tail` | n/a | `[t-new-e-meta]` entries appearing for normal traffic |
| **E-D4** Run cold cohort (n=5, 60s gap); then warm cohort (n=10, back-to-back); all SPA tabs closed | n/a | 15 runs captured, no `falling back to TALK_RUN_QUEUE.send` lines |
| **E-D5** Tail logs into JSON; compute p50 + p90 per phase per cohort; fill §4 tables; commit | docs/T-new-E-t2t1-attribution.md | both tables reconcile to bench t2-t1 ±5 %, with E21 residual ≤ 500 ms |
| **E-D6** Revert the instrumentation commit (single-purpose revert); verify `git diff origin/main -- src/` empty | n/a | empty diff |
| **E-D7** Deploy the reverted build | n/a | prod has no instrumentation |
| **E-D8** Open T-new-E plan PR: three commits (instrumentation + revert + docs) | n/a | review-ready |
| **E-D9** Identify dominant phase from §4; open T-new-E1 plan for the lever | n/a | follow-up plan exists |

No production code lands. The PR's main-vs-PR diff is **identical to pre-merge main on src/** (instrumentation + revert cancel out). Doc artifact (filled attribution tables) is the only durable change.

---

## 7. Out of scope

- **Any fix to t2-t1**. T-new-E is measurement. The fix lives in T-new-E1 (or further).
- **Pre-deploy attribution for t1-t0** (sendChatRoute path). T-new-A/A2/AR/C already did this via T-new-A §4.5.
- **Pre-deploy attribution for t3-t2** (~709 ms first event → first delta). Mostly model TTFT + DO event delivery; small absolute size, lower ROI.
- **Pre-deploy attribution for t4-t3** (~1 ms). Already known: bench prompt is short, single-emit.
- **The DO drain phase (E20)** isolated as its own measurement plan. T-new-B's data put p95 at 464 ms; that's bounded. If E20 dominates the t2-t1 attribution unexpectedly, a follow-up plan can revisit T-new-B's measurement assumptions.

---

## Revision history

- **r1 (initial draft)** — Documents the t2-t1 = 6571 ms p50 finding from the 2026-05-30 bench. Lists E0-E20 phase candidates from static analysis. Submitted for double review.
- **r2 (this revision)** — absorbs codex consult r1 (3 P1 + 5 P2) + karpathy r1 (3 warnings):
  - **§2 inventory:** E18 split (codex P1-A — direct-path pre-LLM prep was conflated with LLM connect; now E18 = prep, E19 = executeWithAgent/LLM, E20 = outbox INSERT, E21 = DO+WS residual). E4 corrected to 3 stmts not 1 (codex P2-F: withUserContext setup is BEGIN + set role + set_config). E20 flagged as fire-and-forget so emit-call-site timing is meaningless (codex P1-B).
  - **§3 instrumentation:** expanded to 5 files (added outbox-emit.ts + streaming-notify.ts per codex P1-B). Wire-statement counter scope extended to `getOutOfBandSql` + withUserContext-setup hook (codex P2-E). Pre-deploy grep verifies inline path is still wired (karpathy W2). waitUntil hazard tracking added (codex P2-D). Cold + warm cohort split (codex P2-G). Clean PR shape with single-purpose instrumentation commit + revert (codex P2-H, karpathy W3). CF tail bandwidth budget computed (karpathy W1).
  - **§4 attribution:** two tables (cold + warm), E21 residual derived not measured (codex P1-C — can't reconcile to client t2 with Worker logs alone). Reconciliation rule with ±5 % tightened.
  - **§5 risks:** expanded to cover waitUntil cap, clock skew, n=10 thinness.
  - **§6 tasks:** D0 grep step added; D1 file count grew to 5; D6 verifies empty src/ diff; D7 deploys reverted build before D8 PR open.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| Codex Consult | `/codex consult` | Plan-stage behavior + framework catches | 1 | **CLEAR (r1 absorbed)** | r1: 3 P1 + 5 P2 absorbed in r2 |
| Karpathy Audit | `/karpathy-audit` (file mode, by hand) | Plan-stage style + four principles | 1 | **CLEAR (r1 absorbed)** | r1: 3 warnings absorbed in r2 (W3 overlapped with codex P2-H; W1+W2 unique) |

- **CROSS-MODEL:** Codex caught all the framework-specific traps (fire-and-forget emit, withUserContext setup, clock skew, waitUntil cap). Karpathy caught the process gaps (pre-deploy verification, log rate-limit budget, PR shape clarity). Near-zero overlap, both load-bearing — same pattern observed in [[feedback-codex-catches-behavior-karpathy-catches-style]].
- **UNRESOLVED:** 0. r2 needs r2 verification pass (codex + karpathy on r2) before the measurement is run.
- **VERDICT:** r2 draft. Significant reshape from r1; recommend r2 verification before deploying the instrumentation commit.
