# T-new-C — `ensureTalkUsesUsableDefaultAgent` happy-path early-exit

**Status:** Plan, **r2 draft**.
**Tracking:** [[project-llm-turn-latency]], [[T-new-A-chat-handler-parallelize]] (the §4.5 attribution that surfaced this).
**Branch (planning):** `docs/t-new-c-ensure-default-agent` (this doc).
**Branch (implementation, to be created):** `feature/t-new-c-ensure-default-agent`.
**Estimated effort:** ~2 h human / ~1.5 h CC.

---

## Revision history

- **r1 (2026-05-29)** — initial draft. Codex returned 2 P1 + 5 P2 (`.codex-r1-findings.txt`). Karpathy returned 1 critical + 2 warning + 1 nit. Critical overlap on the gate-equivalence claim; complementary on enabled-semantics, RLS reference, failure surface, call multiplicity, "99%" hand-wave.
- **r2 (this revision)** — absorbs r1 findings:
  - Widened gate to `activeCount > 0 AND primaryCount = 1 AND orphanCount = 0` (codex P1 #1, karpathy critical).
  - Renamed terminology — snapshot answers "is the assigned-agent set healthy?", not "usable" — and dropped the "usable" overstatement (codex P1 #2).
  - Acknowledged the new throw surface on snapshot SELECT (codex P2 #6) and decided not to swallow it.
  - Fixed RLS reference to migration `0002`, owner-scoped (codex P2 #3).
  - Replaced "99% of calls" hand-wave with measurement-validated framing (karpathy W1).
  - Replaced "§4.6" stale reference with "§7" (karpathy W2).
  - §2.2 + §7 now distinguish function-level (~625 ms per call) from route-level (1× for sendChatRoute, 2× for getTalkRoute and listTalkAgentsRoute, N× for listTalksRoute via toTalkApiRecord) (codex P2 #4).
  - Documented but did NOT fix the redundant inner calls — that's a separate plan (§3.3 deferral).

---

## 1. Context

T-new-A's §4.5 attribution surfaced `ensureTalkUsesUsableDefaultAgent` at **~748 ms median** per call. The function is invoked from four hot-path routes (`src/clawtalk/web/routes/talks.ts:644, 1231, 1270, 1952`) — every `GET /talks/:id`, every `GET /talks/:id/agents`, every `POST /talks/:id/chat`. So this cost lands on essentially every authenticated talk-related request.

The function is a "best-effort healing" fixup: it ensures a talk has at least one assigned agent (the default), and that exactly one of them is marked `is_primary`. In steady state most talks already have healthy agent assignments, so the heal path is rarely taken — yet the full SELECT chain runs every time, on the apparent-happy-path, just to confirm there's nothing to heal. The proportion of calls that hit the early-exit gate is unknown at plan time and validated by the §7 post-deploy bench.

**The lever:** answer the healthy-state question with a single cheap SELECT, and skip the rest of the chain when the talk is already healthy.

This plan is plan-only. No code changes during planning. Implementation lives behind r-N codex+karpathy review per [[feedback-codex-catches-behavior-karpathy-catches-style]].

---

## 2. Surface inventory

### 2.1 The function (confirmed against current main `af4206b`)

`src/clawtalk/agents/agent-registry.ts:255-295` — `ensureTalkUsesUsableDefaultAgent(talkId, ownerId)`.

```ts
export async function ensureTalkUsesUsableDefaultAgent(
  talkId: string,
  ownerId: string,
): Promise<void> {
  let defaultTalkAgentId: string;
  try {
    defaultTalkAgentId = await getDefaultTalkAgentId();          // SELECTs 1-2
  } catch {
    return;
  }
  const defaultTalkAgent = await getRegisteredAgent(defaultTalkAgentId); // SELECT 3
  if (!defaultTalkAgent || defaultTalkAgent.enabled !== true) {
    return;
  }
  const rows = await getTalkAgentRows(talkId);                   // DELETE + SELECTs 4-5
  if (rows.length === 0) {
    await setTalkAgents({ talkId, ownerId, agents: [{ ... }] });
    return;
  }
}
```

### 2.2 The function-level round-trip chain (apparent-happy-path)

Following the call chain into the accessors:

1. `getDefaultTalkAgentId()` (`agent-registry.ts:86`):
   - **SELECT** `settings_kv` for `system.defaultTalkAgentId` (via `getSettingValue`, `accessors.ts:3283`).
   - **SELECT** `registered_agents` for the candidate (via `getRegisteredAgent`, `agent-accessors.ts:244`).
2. Outer caller line 269: **SELECT** `registered_agents` AGAIN with the same ID — **redundant** with step 1's SELECT in the candidate-enabled branch; only meaningful in the main-agent-fallback branch.
3. `getTalkAgentRows(talkId)` (`talk-agents.ts:225`):
   - Internally calls `pruneDeletedTalkAgentAssignments(talkId)` (`talk-agents.ts:303`):
     - **DELETE** `talk_agents where registered_agent_id IS NULL` (no-op on healthy talks, but the round-trip still happens).
     - **SELECT** `talk_agents` for remaining rows (the prune's primary-count check).
     - Optional **UPDATE** if primary count != 1 (heal path only).
   - Then **SELECT** `talk_agents` for the actual returned rows.

**Round-trip count per function call on the apparent-happy-path: 6** (3 settings/registered_agents SELECTs + 1 DELETE + 2 talk_agents SELECTs). At Joseph's measured ~125 ms p50 per Hyperdrive round trip, that's ~750 ms — matching T-new-A's attribution.

### 2.3 Function calls per route — the multiplicity surprise

The function isn't called once per request — it's called **N times** depending on the route:

| Route | Direct call site | Indirect calls (via `listEffectiveTalkAgents` line 644 or `toTalkApiRecord` line 273) | Total per request |
|---|---|---|---|
| `POST /talks/:id/chat` (`sendChatRoute`) | talks.ts:1952 | none | **1×** |
| `GET /talks/:id` (`getTalkRoute`) | talks.ts:1231 | `toTalkApiRecord` at line 1238 (1 call) | **2×** |
| `GET /talks/:id/agents` (`listTalkAgentsRoute`) | talks.ts:1270 | `listEffectiveTalkAgents` at line 1278 (1 call) | **2×** |
| `GET /talks` (`listTalksRoute`) | none | `toTalkApiRecord` per talk at line 686 — runs once per talk in the list | **N×** (one per talk) |

So per-route savings scale by multiplicity. A 50-talk list view today eats 50 × ~750 ms = ~37 s of `ensureTalkUsesUsableDefaultAgent` cost; even amortized over Hyperdrive concurrency that's a large structural inefficiency.

The multiplicity itself is a separate (and arguably larger) lever — the redundant inner calls inside `listEffectiveTalkAgents` and `toTalkApiRecord` are likely unintended. This plan does NOT fix them (§3.3 deferral); it makes each call cheaper on the apparent-happy-path, which compounds across the multiplicity.

Per [[feedback-verify-schema-facts-in-plan-gates]] — every identifier above round-tripped through grep against current main (`af4206b`).

---

## 3. The fix — early-exit on healthy state

### 3.1 What changes

Add a single cheap accessor that answers "is this talk's agent set already healthy?" in 1 RT, and gate the rest of `ensureTalkUsesUsableDefaultAgent` behind it. The snapshot answers the **assigned-agent shape** question (count + primary marker + orphan presence) — NOT the "is the assigned agent's registered_agents row enabled" question, which today's code also doesn't truly verify for assigned agents (it verifies only the default-agent fallback). Terminology kept narrow on purpose: "assigned-agent shape" instead of "usable agent" to avoid the codex P1 #2 overstatement.

**New accessor** in `src/clawtalk/db/talk-agents.ts`:

```ts
export async function getTalkAgentsHealthSnapshot(
  talkId: string,
): Promise<{
  activeCount: number;   // rows with non-null registered_agent_id
  primaryCount: number;  // rows where is_primary = true (regardless of FK)
  orphanCount: number;   // rows with null registered_agent_id (prune target)
}> {
  const db = getDbPg();
  const rows = await db<Array<{
    active_count: string; primary_count: string; orphan_count: string;
  }>>`
    select
      count(*) filter (where registered_agent_id is not null) as active_count,
      coalesce(sum((is_primary)::int), 0)                     as primary_count,
      count(*) filter (where registered_agent_id is null)     as orphan_count
    from public.talk_agents
    where talk_id = ${talkId}::uuid
  `;
  return {
    activeCount: Number(rows[0]?.active_count ?? 0),
    primaryCount: Number(rows[0]?.primary_count ?? 0),
    orphanCount: Number(rows[0]?.orphan_count ?? 0),
  };
}
```

**Rewritten `ensureTalkUsesUsableDefaultAgent`**:

```ts
export async function ensureTalkUsesUsableDefaultAgent(
  talkId: string,
  ownerId: string,
): Promise<void> {
  // Cheap shape check: 1 RT instead of 6 in steady state.
  // Conditions match the post-prune invariant in talk-agents.ts:303-332:
  // - activeCount > 0: at least one usable assignment
  // - primaryCount = 1: post-prune primary invariant holds
  // - orphanCount = 0: prune would have been a no-op (no null-FK rows to delete)
  const health = await getTalkAgentsHealthSnapshot(talkId);
  if (
    health.activeCount > 0 &&
    health.primaryCount === 1 &&
    health.orphanCount === 0
  ) {
    return;
  }
  // Heal path: existing logic unchanged.
  let defaultTalkAgentId: string;
  try {
    defaultTalkAgentId = await getDefaultTalkAgentId();
  } catch {
    return;
  }
  const defaultTalkAgent = await getRegisteredAgent(defaultTalkAgentId);
  if (!defaultTalkAgent || defaultTalkAgent.enabled !== true) {
    return;
  }
  const rows = await getTalkAgentRows(talkId);
  if (rows.length === 0) {
    await setTalkAgents({ talkId, ownerId, agents: [{ /* unchanged */ }] });
    return;
  }
}
```

### 3.2 Expected savings

- **Healthy-shape path** (activeCount > 0, primaryCount = 1, orphanCount = 0): 6 RT → 1 RT = **~625 ms saved per function call.**
- **Heal-shape path** (any condition fails): 6 RT → 7 RT = **~125 ms regression per function call.** Acceptable — heal is not on the steady-state user path.

The proportion of calls in each bucket is unknown at plan time. The §7 post-deploy bench is the validation gate. If healthy-shape covers ≥80 % of calls, structural saving carries through. If <50 %, file `T-new-C-followup.md` per §7.

Per-route savings compound by §2.3 multiplicity. The bench reports both function-level (per-call saving) and route-level (per-request saving) deltas to keep the prediction honest.

### 3.3 What's NOT in this plan (deferred)

- **Dedupe `getDefaultTalkAgentId` → return the agent record, not just the ID.** Would save 1 more RT on the heal path. Deferred — heal is rare; touches `getDefaultTalkAgentId`'s API contract.
- **Remove redundant inner calls** to `ensureTalkUsesUsableDefaultAgent` inside `listEffectiveTalkAgents:644` and `toTalkApiRecord:273`. These are the source of the §2.3 multiplicity and almost certainly the bigger lever in absolute terms (N×-amplified on `listTalksRoute`). Separate plan — needs care because the inner calls were added defensively; removing them shifts responsibility to every route caller.
- **Pre-deploy instrumentation gate** (per [[feedback-measure-before-locking-perf-plans]]). Predicted win is ~625 ms per call (well above the 200 ms threshold), and T-new-A's §4.5 already attributed the function. Post-deploy bench validates.
- **Tighten `pruneDeletedTalkAgentAssignments`** to short-circuit when no work is needed. Separate accessor with separate callers; out of this scope.
- **Filter `getRegisteredAgent` by `enabled = true`** to match the snapshot semantics (codex P1 #2 secondary). Out of scope — that's a behavioral change in `getRegisteredAgent` itself, not just here.

---

## 4. Risks and correctness

### 4.1 Gate equivalence — three-field check

The widened gate `activeCount > 0 AND primaryCount = 1 AND orphanCount = 0` covers the three failure modes that `pruneDeletedTalkAgentAssignments` + the function's own `rows.length === 0` check together address:

| Talk state | activeCount | primaryCount | orphanCount | Gate verdict | Existing-code behavior |
|---|---|---|---|---|---|
| 1 active primary, no orphans | 1 | 1 | 0 | **HEALTHY** | prune no-op, function early-returns | ✅ equivalent |
| 1 active non-primary, no orphans | 1 | 0 | 0 | HEAL | prune updates primary on surviving row | ✅ heal path runs |
| 2 active rows, 0 primary | 2 | 0 | 0 | HEAL | prune updates first row to primary | ✅ heal path runs |
| 2 active rows, 2 primary (invariant broken) | 2 | 2 | 0 | HEAL | prune updates first row, demotes others | ✅ heal path runs |
| 1 active primary + 1 orphan | 1 | 1 | 1 | HEAL | prune deletes orphan, no UPDATE needed | ✅ heal path runs |
| 1 active non-primary + 1 orphan primary (codex P1 #1 case b) | 1 | 1 | 1 | HEAL | prune deletes orphan + UPDATEs survivor primary | ✅ heal path runs |
| 0 active, 1+ orphans | 0 | * | ≥1 | HEAL | prune deletes orphans + heal-from-default | ✅ heal path runs |
| 0 active, 0 orphans (empty) | 0 | 0 | 0 | HEAL | prune no-op, heal-from-default | ✅ heal path runs |

The gate is **strictly tighter** than the current implicit check — every state the current code modifies routes to the heal path, plus a few states that today would no-op route to the heal path too. The cost: a small number of extra heal-path runs that do nothing (the function early-returns at `rows.length === 0` check after re-reading via `getTalkAgentRows`). These are bounded by the rare-orphan rate.

### 4.2 Snapshot SELECT failure surface — new throw

Today's `ensureTalkUsesUsableDefaultAgent` swallows `getDefaultTalkAgentId()` errors via `try { ... } catch { return }`. That swallow covers two cases: (a) "no default agent configured" — benign on a fresh install, and (b) DB connection error — *also* swallowed today (arguably a hidden bug).

The proposed snapshot SELECT does NOT wrap in try/catch. A DB error on the snapshot throws to the caller (a talks.ts route handler), which surfaces as a 500. That **IS a new failure surface vs today** (codex P2 #6). Decision: accept the more honest failure. Hiding DB errors on the read path was masking real problems. Documented in §8.

### 4.3 RLS surface

`talk_agents` RLS lives in `supabase/migrations/0002_rls_policies.sql:105-116`, owner-scoped: `talk_agents_owner using (owner_id = auth.uid())`. The new snapshot SELECT runs inside `withUserContext(auth.uid())`, so it inherits owner-id RLS the same way the existing `getTalkAgentRows` does. Filtering by `talk_id` alone is correct — owner-scope is added by Postgres at policy-application time. (r1 incorrectly cited migration `0001`; fixed.)

### 4.4 Concurrent mutation between snapshot and heal

If another request mutates `talk_agents` between the snapshot SELECT and a subsequent `setTalkAgents` write in this same request:

- The heal path still re-reads via `getTalkAgentRows` BEFORE writing — so the writer sees the latest state.
- `setTalkAgents` is full-replace ([[feedback-settalkagents-full-replace]]); last writer wins.
- The healthy-shape early-exit could skip a prune that the *current* code would have performed if a concurrent insert lands between snapshot and the existing `getTalkAgentRows` call. The window is ~1 RT (the gap between SELECT and the next operation). Benign in practice — the next request's `ensureTalkUsesUsableDefaultAgent` or `getTalkAgentRows` call will catch it (`getTalkAgentRows` is called from many non-`ensure` paths).

Net: race surface is **slightly different but not strictly worse**. The previous plan claim "preserves the existing race" was overbroad (codex P2 #2); corrected here.

### 4.5 What could break a previously-healthy talk's read

Postgres.js coerces `count(*) FILTER (...)` and `coalesce(sum(...))` to strings (the BigInt-as-string pattern). `Number(rows[0]?.active_count ?? 0)` produces:
- `"1"` → `1` ✓
- `"0"` → `0` ✓
- `undefined` (snapshot returned empty array — impossible for an aggregation without GROUP BY) → `0` ✓
- `null` (theoretical) → `0` ✓ via the `?? 0` guard

This pattern is the same one already used by `loadEnqueueTurnContext` and other accessors. Codex confirmed correctness (P2 #1).

---

## 5. Tests

Three test files touched:

### Test 1 — `src/clawtalk/db/talk-agents.test.ts` (new)

`getTalkAgentsHealthSnapshot` returns correct counts across fixtures. Six cases mapping to §4.1's table rows. Use `seedAuthUser` + `withUserContext` pattern from `accessors.test.ts:84-96, 119-141`.

### Test 2 — `src/clawtalk/agents/agent-registry.test.ts` (extend)

`ensureTalkUsesUsableDefaultAgent` gating behavior:

- **Healthy-shape gate hit:** seed talk with 1 active primary row + 0 orphans → call → assert `setTalkAgents`, `getDefaultTalkAgentId`, `getRegisteredAgent`, `getTalkAgentRows` were NOT called (via spies / call-count assertions).
- **Orphan-present heal:** seed talk with 1 active primary + 1 orphan → call → assert `pruneDeletedTalkAgentAssignments` ran (post-condition: orphan row gone).
- **Empty-agents heal:** seed talk with 0 rows → call → assert default agent was set.
- **Broken-primary heal:** seed talk with 2 active rows + 0 primary → call → assert prune fixed primary.

### Test 3 — `src/clawtalk/web/routes/talks.test.ts` (regression)

Existing four-caller happy-path tests must continue to pass without modification. Specifically `sendChatRoute` (the latency-sensitive path) confirms the gate doesn't break end-to-end `/chat`. The `listTalkAgentsRoute` test covers the double-call route shape.

---

## 6. Implementation tasks

| Task | Files | Verify |
|---|---|---|
| **C1** Add `getTalkAgentsHealthSnapshot` accessor | `src/clawtalk/db/talk-agents.ts` (~30 LoC) | Test 1 passes |
| **C2** Rewrite `ensureTalkUsesUsableDefaultAgent` | `src/clawtalk/agents/agent-registry.ts:255` (gate added; existing logic preserved behind gate) | Test 2 passes |
| **C3** Tests | `src/clawtalk/db/talk-agents.test.ts` (new) + `src/clawtalk/agents/agent-registry.test.ts` (extend) | `npm run test` 1037+5 passes |
| **C4** Push PR. Run `/codex review` + `/karpathy-audit diff` on diff. Absorb findings. | n/a | both PASS clean |
| **C5** Deploy. Function-level bench + route-level bench (§7). | n/a | targets met |

---

## 7. Post-deploy verification

Per [[feedback-measure-before-locking-perf-plans]]: T-new-A's §4.5 already gave the 748 ms baseline. The bench validates that savings materialize at function-level (per-call) AND at route-level (per-request, accounting for §2.3 multiplicity).

**Bench commands** (SPA tabs closed per [[feedback-close-clawtalk-tabs-before-bench]]):

- `npx tsx scripts/latency-bench.ts --provider=haiku --route=chat` (n=10) — measures `sendChatRoute` (1× call).
- `npx tsx scripts/latency-bench.ts --provider=haiku --route=get-talk` (n=10) — measures `getTalkRoute` (2× call).
- A new function-level micro-bench wrapping a direct `ensureTalkUsesUsableDefaultAgent` call against a healthy talk and a heal-required talk (logged via temp instrumentation, removed after deploy).

**Success criteria**:

1. Function-level micro-bench: **healthy-shape call ≥500 ms faster** than pre-T-new-C baseline.
2. Route-level `sendChatRoute` t1-t0: **median drops by ≥500 ms** vs the post-T-new-A baseline (3920 ms → ≤3420 ms).
3. Route-level `getTalkRoute`: **median drops by ≥1000 ms** (2× multiplicity).
4. **Zero new error classes** in 24h prod logs after deploy. Specifically, check for new 500s on snapshot SELECT failures (§4.2 acknowledged surface).

If function-level shows ≥500 ms drop but route-level shows <300 ms drop, the structural hypothesis is right but multiplicity is masking the saving differently than expected. Acceptable; file `T-new-C-followup.md` for the §3.3 redundant-inner-calls deferral.

If function-level shows <300 ms drop, the gate is firing less than expected (healthy-shape proportion lower than predicted). Log `getTalkAgentsHealthSnapshot` outcomes for 24h and reframe.

---

## 8. Failure modes (new code paths only)

| Failure | Behavior | Recovery |
|---|---|---|
| `getTalkAgentsHealthSnapshot` SELECT throws | `ensureTalkUsesUsableDefaultAgent` throws → caller (talks.ts route) throws → 500. **New surface** vs today's swallow on the same DB-error class (§4.2). | Deliberate. Today's swallow hid real DB errors; surfacing is more honest. If observed in prod, root-cause the DB error rather than re-instate the swallow. |
| `postgres.js` coerces counts as strings | `Number(rows[0]?.active_count ?? 0)` handles correctly (§4.5). | n/a |
| Snapshot reads stale row count under concurrent mutation | Slightly different race than today's; §4.4 argues benign. | Next request's call catches it. |
| Snapshot SQL accidentally OR-s `is_primary` against null-FK rows | `(is_primary)::int` over a NULL `is_primary` yields NULL; `sum(NULL) = NULL`; `coalesce(..., 0) = 0` makes the gate refuse healthy → routes to heal. Harmless mis-classification. | n/a |

---

## 9. Out of scope

- Dedupe `getDefaultTalkAgentId` to return the agent record (deferred — §3.3).
- Inline heal-path write into snapshot transaction (deferred — §3.3).
- `pruneDeletedTalkAgentAssignments` redesign (out of scope — shared accessor).
- `getRegisteredAgent` enabled-filter tightening (out of scope — separate behavioral change).
- Redundant-inner-call removal in `listEffectiveTalkAgents` + `toTalkApiRecord` (§3.3 — separate plan, likely a bigger lever).

---

## GSTACK REVIEW REPORT

| Review | Method | What it checked | Findings | Verdict | Notes |
|---|---|---|---|---|---|
| Codex consult (r1) | `/codex consult` | Behavior + framework-specific (gate equivalence, postgres.js coercion, RLS, race, route multiplicity, failure surface) | 2 P1 + 5 P2 | NOT CLEAR → r2 | Counterexamples on the gate, double-call on `listTalkAgentsRoute`, RLS reference accuracy. All absorbed. `.codex-r1-findings.txt`. |
| Karpathy audit (r1) | `/karpathy-audit` against the plan | Style + four principles (coverage + quality) | 4/4 coverage; 1 critical + 2 warning + 1 nit | NOT CLEAR → r2 | Critical (orphan-row case) overlapped with codex P1; W1 (99% hand-wave), W2 (§4.6 stale ref) absorbed. NIT (coalesce) skipped — left as-is. |
| Codex consult (r2) | `/codex consult` | Re-verify equivalence with widened gate, multiplicity claim, failure-surface decision | pending | pending | To run on this revision. |
| Karpathy audit (r2) | `/karpathy-audit` | Re-verify style on the rewritten r2 | pending | pending | To run alongside codex r2. |
