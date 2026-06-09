# ClawTalk MVP Eval Suite

> **Status:** MVP dry-run harness implemented and CI-gated; persisted live-observation scoring available · **Updated:** 2026-06-08
> Implements the Phase 13 offline eval gate shape from [`05-build-plan.md`](./05-build-plan.md) Phase 13 and [`06-agent-system-design.md`](./06-agent-system-design.md) §14.2.

## What Runs

The eval gate CLI/assets live under [`../eval`](../eval), with typechecked harness code in `src/clawtalk/eval`, and runs with:

```bash
npm run eval
```

The default mode is deterministic `dry-run`. It reads scenario contracts from `eval/scenarios/*.json`, derives observed signals from nested fixture events/records/agent replies in `eval/fixtures/*.json`, validates grader prompt contracts from `eval/graders/*.json`, and prints a pretty report. Top-level fixture `signals` are rejected so the gate cannot pass by simply copying required signals into a flat array. Use `--output=<path>` for machine-readable reports, or `npm --silent run eval -- --format=json` when piping JSON stdout.

Live evaluator-model grading is deliberately not claimed yet. `npm run eval -- --mode=live` exits blocked unless a persisted live observation directory is supplied with `--live-root=<dir>`. This keeps local launch-gate proof separate from future provider-scored coverage while allowing captured Worker/workspace runs to be scored against the same launch-critical signal contracts.

## CI Policy

Pull-request CI runs the deterministic dry-run gate with `npm run eval` after root typecheck and before the Supabase-backed test phase. That makes scenario/fixture/grader drift a required merge signal without needing Joseph secrets, external providers, or local Supabase.

Live eval remains manual and intentionally outside CI. Do not make `--mode=live --live-root=<dir>` required until the Worker/workspace capture path, evaluator-model credentials, and stable launch thresholds are implemented.

## Launch-Critical Scenarios

| Scenario                            | Coverage                                                                                                                                                     |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `s-talk-pricing-launch`             | Default 5-agent ordered Talk path, role differentiation, persisted run/messages, and `AgentAuditResult`-shaped per-agent scores.                             |
| `s-talk-failure-budget-guard`       | Talk partial-failure visibility, preserved successful output, retry/cancel affordance, and over-budget agent flagging.                                       |
| `s-documents-native-edit-flow`      | Native documents/tabs/blocks reads, pending edits, accept, reject, stale accept conflict, and no markdown/html facade dependency.                            |
| `s-jobs-document-output-home-inbox` | `emit_document_append`, pending document edit from a job run, `job_output_ready`, Home inbox deep link, idempotency, and blocked no-primary-document output. |
| `s-home-lifecycle-visibility`       | Home inbox visibility for job/document/recommendation items plus read, resolve, dismiss, snooze, expiry, and module isolation.                               |
| `s-workspace-permissions-isolation` | Member reads, non-member denial, cross-workspace rejection, and connector/OAuth credential privacy.                                                          |

These are launch-useful MVP scenarios, not replacements for unit or integration tests. The dry-run fixtures prove the gate contract, report shape, thresholds, nested observation derivation, and local execution path without requiring Joseph secrets or external model calls.

All dry-run fixture observations are contract placeholders until live Worker/integration execution lands. A green dry-run proves the invariants are represented in the eval set, that signals are backed by structured fixture observations, and that threshold mechanics work; it does not prove backend enforcement of Talk failure handling, native document conflicts, Jobs output, Home lifecycle actions, non-member denial, cross-workspace rejection, or OAuth credential privacy. Persisted live observations must use the same per-scenario filenames as `eval/scenarios/*.json`, set `source: "live"`, and attach signals only to nested events, records, or agent replies.

## Scoring And Thresholds

The canonical agent audit scale is 1-5, matching `06-agent-system-design.md`:

- `roleAdherence`
- `nonDuplication`
- `evidenceDiscipline`
- `methodAdherence`
- `usefulness`
- `concision`

The earlier skeleton referenced a 0-10 grader scale, but the current canonical
`AgentAuditResult` contract in `06-agent-system-design.md` §14.2 is 1-5, and
`05-build-plan.md` Phase 13 uses `>= 4.0` examples for launch thresholds.

Each scenario has a default threshold of `4.0`. A scenario passes when:

1. every launch-critical check meets its threshold;
2. every per-agent audit dimension, when present, meets the scenario threshold;
3. the combined scenario mean is at least the scenario threshold.

The suite passes only when every selected scenario passes. Scores are deterministic in dry-run mode: each check scores required fixture signals from 1 to 5, and any missing required signal fails that check even if the numeric score reaches the threshold. The gate also validates all six grader prompt contracts before it can pass.

## CLI

```bash
npm run eval -- --help
npm run eval -- --list
npm run eval -- --scenarios=s-talk-pricing-launch
npm run eval -- --output=eval-report.json
npm run eval -- --mode=live --live-root=tmp/eval-live-observations
npm --silent run eval -- --format=json
```

Options:

- `--mode=dry-run|live` - dry-run is local and deterministic; live requires `--live-root`.
- `--live-root=<path>` - directory containing persisted live observation JSON files, one per selected scenario using that scenario's `fixture` filename and `source: "live"`.
- `--scenarios=all|id,id` - run all scenarios or a comma-separated subset.
- `--format=pretty|json` - print a readable table or JSON report. Use `npm --silent` for parseable JSON stdout.
- `--output=path` - write the JSON report to disk. This avoids npm's script banner on stdout.
- `--list` - list scenario ids.

Exit codes:

- `0` - suite passed.
- `1` - suite ran but failed thresholds.
- `2` - suite is blocked, currently only for live mode without `--live-root`.

## Grader Prompts

`eval/graders/*.json` defines one prompt contract per audit dimension. The prompt files use a strict `numeric_1_to_5` output contract with `score`, `flags`, and `explanation`. The MVP dry-run harness does not call a model; these files are the stable contract for the future live evaluator adapter.

## Reading The Report

The pretty report starts with suite status, evaluator version, generated timestamp, scenario pass count, critical check failures, and agent audit failures. Failed checks list missing deterministic signals. JSON output includes the same data with `AgentAuditResult`-shaped rows:

```ts
type AgentAuditResult = {
  runId: string;
  scenarioId: string;
  agentRole: 'strategist' | 'critic' | 'researcher' | 'editor' | 'quant';
  evaluatorVersion: string;
  scores: Record<ScoreDimension, number>; // 1-5 each
  flags: string[];
  explanation: string;
  createdAt: string;
  passed: boolean;
};
```

## Next Up

The next eval hardening step is live capture and model grading: run scenarios against a local Worker/workspace fixture, persist real Talk/Documents/Jobs/Home observations into a `--live-root` directory, and then call evaluator-model graders. Until that lands, `npm run eval` is a local MVP gate that proves coverage shape and threshold mechanics, and `--mode=live --live-root=<dir>` proves captured observations satisfy the deterministic contracts, not live model quality.
