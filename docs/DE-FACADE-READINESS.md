# De-Facade Readiness Ledger

> **Status:** deletion blocked by live consumers · **Updated:** 2026-06-08
> **Scout command:** `scripts/de-facade-readiness.sh`

This ledger is a deletion-precondition tracker, not an approval to delete. Every
facade must first get native consumers, tests over the native shape, and a grep
proof showing no live consumers remain.

The scout script requires `rg`, scans `src` and `webapp`, excludes tests, and prints top
evidence. Current local scout output:

| Facade | Live consumer count | Current evidence | Native replacement | Deletion preconditions |
|---|---:|---|---|---|
| Synthetic `threadId` | 327 | `webapp/src/pages/TalkDetailPage.tsx`, `webapp/src/lib/api.ts`, `src/clawtalk/web/routes/greenfield-detail.ts`, `src/clawtalk/web/routes/greenfield-chat.ts` | Treat Talk as the conversation; runs/messages/content use talk/run/document ids without fabricated thread identity. | TalkDetail URL/state no longer depends on `?thread=`; `webapp/src/lib/api.ts` has native talk/run/message DTOs; backend no longer calls `syntheticThreadId`; tests use talk/run/document ids; scout count is zero outside historical docs. |
| Runs/messages with `threadId` | included in synthetic count | `TalkRun`, `TalkMessage`, stream events, cancellation and job-settled callbacks still carry `threadId`. | Native run/message contracts using run id, round/response group, and talk id. | Streaming reducer and run panels consume native ids; cancellation/history APIs do not accept thread ids; tests no longer synthesize default thread ids. |
| Flat content body projection | 0 | No live `bodyMarkdown`/`bodyHtml` matches. Old flat-content HTTP route mounts/helpers for `/talks/:talkId/content`, `/threads/:threadId/content`, and `/contents/:contentId[...]` are deleted; native `POST /api/v1/documents` handles Talk doc-pane creation; Talk snapshots expose native `primaryDocument` metadata instead of flattening blocks into body fields. | Native `documents`/`doc_tabs`/`doc_blocks` plus `document_edits` CAS flows. | Retired. Keep the scout at zero; do not reintroduce flat body fields or compatibility content routes. |
| Snapshot compat `snapshotVersion` | 0 | No live `snapshotVersion` matches. Snapshot hydration now exposes `eventHighWater`, and the backend accessor is named `getTalkEventHighWater`. | Native talk hydration cursor named for event high-water semantics. | Retired. Keep `snapshotVersion` and `getTalkSnapshotVersion` grep-clean; native cache/router/hydration tests should continue covering event high-water behavior. |
| Run-context fabrication | 0 | No live fabricated `contextSnapshot`, `context_manifest_json`, synthetic thread, source-manifest, or default manifest-field matches. `/api/v1/talks/:talkId/runs/:runId/context` now returns native `context` details or `null` when no prompt snapshot payload exists. | Native run context with real persona role, prompt presence/token estimate, context runtime tools, trigger message id, and turn count. | Retired. Keep fabricated run-context symbols grep-clean; backend and Talk UI tests cover present and missing native context states. |
| Tool-family compatibility | 5 | `src/clawtalk/db/agent-accessors.ts` still reads `active_tool_families_json`; UI imports `webapp/src/lib/tool-families.ts`. | Per-tool rows in `talk_tools(workspace_id, talk_id, tool_id, enabled)`. | All read/write paths use `talk_tools`; `active_tool_families_json` fallback removed; ToolChipsBar and settings surfaces show tool ids or native grouped labels without family DTO compatibility. |
| Channels/data-connectors compatibility | 34 | `webapp/src/lib/api.ts`, `SettingsPage.tsx`, `TalkDetailPage.tsx`, `src/clawtalk/web/worker-app.ts`, `src/clawtalk/web/routes/connectors.ts` | Single connectors and connector bindings surface. | Settings/Talk connector UI consumes native connectors/bindings; `/workspace/channels`, `/workspace/data-connectors`, and per-talk connector API client methods are unused; backend compatibility routes have zero import/route evidence before deletion. |
| Policy facade | 0 | No live `/api/v1/talks/:talkId/policy`, `getGreenfieldTalkPolicyRoute`, or `updateGreenfieldTalkPolicyRoute` matches. The legacy route mount and no-op facade handlers are deleted. | Native roster and run settings over `talk_agents`, `talk_agent_snapshots`, and talk settings. | Retired. Keep policy route/client wrapper grep-clean; native `/agents` tests cover roster read/write behavior. |
| Duplicate Hono mounts | 3 each | `reorderGreenfieldTalkSidebarRoute` and `getGreenfieldRunContextRoute` are now present only as implementation definition, canonical import, and canonical call through `mountGreenfieldApiRoutes`. | One canonical mount per route family. | Deleted; direct `worker-app.ts` route registrations are absent, and the surviving routes resolve through `greenfield-api.ts`. |

## Safe Order

1. Native Documents consumers first; flat content compatibility route deletion and snapshot body projection removal are complete.
2. Run-context fabrication is retired; keep the native route and UI tests as regression coverage.
3. Talk native DTOs next: drop synthetic thread identity from API client, stream reducer, and TalkDetail state before backend removal.
4. Connector/tool facades after Settings/Talk connector consumers move to native connectors/bindings and per-tool ids.
5. Duplicate route mounts can be removed when their owning route module is unambiguous and route tests cover the surviving mount.

## Required Proof Per Deletion

- `scripts/de-facade-readiness.sh` output before and after.
- `rg` proof for the specific facade token and route path.
- Native consumer tests passing before deletion.
- Backend route/accessor tests proving the native replacement.
- Karpathy diff audit proving no unrelated surface was touched.
- Structural and cross-model reviews before merge.
