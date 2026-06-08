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
| Synthetic `threadId` | 330 | `webapp/src/pages/TalkDetailPage.tsx`, `webapp/src/lib/api.ts`, `src/clawtalk/web/routes/greenfield-detail.ts`, `src/clawtalk/web/routes/greenfield-chat.ts` | Treat Talk as the conversation; runs/messages/content use talk/run/document ids without fabricated thread identity. | TalkDetail URL/state no longer depends on `?thread=`; `webapp/src/lib/api.ts` has native talk/run/message DTOs; backend no longer calls `syntheticThreadId`; tests use talk/run/document ids; scout count is zero outside historical docs. |
| Runs/messages with `threadId` | included in synthetic count | `TalkRun`, `TalkMessage`, stream events, cancellation and job-settled callbacks still carry `threadId`. | Native run/message contracts using run id, round/response group, and talk id. | Streaming reducer and run panels consume native ids; cancellation/history APIs do not accept thread ids; tests no longer synthesize default thread ids. |
| Flat content `bodyMarkdown`/`bodyHtml` | 5 | `src/clawtalk/web/routes/greenfield-detail.ts` snapshot `toContentApi` projection; old flat-content HTTP route mounts/helpers for `/talks/:talkId/content`, `/threads/:threadId/content`, and `/contents/:contentId[...]` are deleted, native `POST /api/v1/documents` handles Talk doc-pane creation, and old content create client calls are gone. | Native `documents`/`doc_tabs`/`doc_blocks` plus `document_edits` CAS flows. | Snapshot response contract stops exposing `content.bodyMarkdown/bodyHtml`; page-level fixtures move to native document blocks; audit proves zero live consumers before deleting the final projection. |
| Snapshot compat `snapshotVersion` | 15 | `TalkDetailPage.tsx`, `webapp/src/lib/wsCacheRouter.ts`, `webapp/src/lib/api.ts`, `src/clawtalk/web/routes/greenfield-detail.ts`, `greenfield-detail-accessors.ts` | Native talk hydration cursor/version named for event high-water semantics. | Client cache/router uses native cursor naming; backend route contract stops presenting outbox high-water as snapshot version; stale snapshot tests are rewritten around the native cursor. |
| Run-context fabrication | 38 | `webapp/src/lib/api.ts`, `TalkRunsPanel`, `src/clawtalk/web/routes/greenfield-detail.ts`, `src/clawtalk/talks/talk-run-context-snapshot.ts`, `greenfield-detail-accessors.ts` | Persisted run prompt/context snapshot without legacy thread fields or fabricated manifests. | Run context API type matches persisted snapshot shape; UI no longer expects legacy manifest fields such as `goalIncluded`, `stateSnapshot`, `forcedInjection`, or `connectorToolNames`; `context_manifest_json` compatibility is gone; one route mount remains; tests cover missing/present context snapshots in native shape. |
| Tool-family compatibility | 5 | `src/clawtalk/db/agent-accessors.ts` still reads `active_tool_families_json`; UI imports `webapp/src/lib/tool-families.ts`. | Per-tool rows in `talk_tools(workspace_id, talk_id, tool_id, enabled)`. | All read/write paths use `talk_tools`; `active_tool_families_json` fallback removed; ToolChipsBar and settings surfaces show tool ids or native grouped labels without family DTO compatibility. |
| Channels/data-connectors compatibility | 34 | `webapp/src/lib/api.ts`, `SettingsPage.tsx`, `TalkDetailPage.tsx`, `src/clawtalk/web/worker-app.ts`, `src/clawtalk/web/routes/connectors.ts` | Single connectors and connector bindings surface. | Settings/Talk connector UI consumes native connectors/bindings; `/workspace/channels`, `/workspace/data-connectors`, and per-talk connector API client methods are unused; backend compatibility routes have zero import/route evidence before deletion. |
| Policy facade | 2 | `src/clawtalk/web/routes/greenfield-api.ts` mounts `/api/v1/talks/:talkId/policy`. | Native roster and run settings over `talk_agents`, `talk_agent_snapshots`, and talk settings. | UI no longer calls policy route; native roster/update tests cover the same behavior; route grep proves no frontend/API client consumers. |
| Duplicate Hono mounts | 3 each | `reorderGreenfieldTalkSidebarRoute` and `getGreenfieldRunContextRoute` are now present only as implementation definition, canonical import, and canonical call through `mountGreenfieldApiRoutes`. | One canonical mount per route family. | Deleted; direct `worker-app.ts` route registrations are absent, and the surviving routes resolve through `greenfield-api.ts`. |

## Safe Order

1. Native Documents consumers first, then flat content compatibility route deletion.
2. Talk native DTOs next: drop synthetic thread identity from API client, stream reducer, and TalkDetail state before backend removal.
3. Snapshot/run-context native naming after Talk DTO migration, because both currently ride on the thread-shaped snapshot contract.
4. Connector/tool/policy facades after Settings/Talk connector consumers move to native connectors/bindings and per-tool ids.
5. Duplicate route mounts can be removed when their owning route module is unambiguous and route tests cover the surviving mount.

## Required Proof Per Deletion

- `scripts/de-facade-readiness.sh` output before and after.
- `rg` proof for the specific facade token and route path.
- Native consumer tests passing before deletion.
- Backend route/accessor tests proving the native replacement.
- Karpathy diff audit proving no unrelated surface was touched.
- Structural and cross-model reviews before merge.
