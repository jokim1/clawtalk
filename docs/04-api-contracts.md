> **Status:** canonical (API).
> Precedence + orientation: [README.md](./README.md) · decisions: [DECISIONS.md](./DECISIONS.md) · terms: [GLOSSARY.md](./GLOSSARY.md).

# ClawTalk · API Contracts

Framework-agnostic backend contracts derived from the prototype's behavior. Transport is **REST + WebSocket** — there is no SSE fallback. All endpoints are workspace-scoped unless noted. The canonical object hierarchy and document relationship are defined in `08-information-architecture.md`.

---

## §0 · Conventions

- **Base URL:** `https://api.clawtalk.app/v1`
- **Authentication:** `Authorization: Bearer <session_token>` for user requests, `Authorization: Bearer <api_key>` for programmatic.
- **Tenant scoping:** Every request that touches user data includes `X-Workspace-Id: <wid>` header. Reject mismatches.
- **Timestamps:** ISO 8601 UTC. Always.
- **IDs:** Opaque strings, ≤ 64 chars. Prefix by entity type: `ws_`, `f_`, `t_`, `d_`, `a_`, `team_`, `msg_`, `run_`.
- **Pagination:** Cursor-based. `?cursor=<opaque>&limit=50`. Response includes `nextCursor` (null when done).
- **Errors:** `{ error: { code: "VALIDATION_FAILED", message: "...", details: { ... } } }`. Use standard HTTP status codes.

---

## §1 · Auth & sessions

### Sign-in flows

| Endpoint                       | Purpose                                   |
| ------------------------------ | ----------------------------------------- |
| `POST /auth/magic-link`        | `{ email }` → sends magic link            |
| `GET /auth/callback?token=...` | Magic-link callback. Sets session cookie. |
| `GET /auth/google`             | OAuth start                               |
| `GET /auth/google/callback`    | OAuth callback                            |
| `GET /auth/github`             | OAuth start                               |
| `GET /auth/github/callback`    | OAuth callback                            |
| `POST /auth/sign-out`          | Invalidate session                        |
| `GET /me`                      | Returns current user + workspaces list    |

### `GET /me`

```ts
{
  user: { id, name, email, avatarColor, initials },
  workspaces: [{ id, name, role: 'owner' | 'admin' | 'member', initials }],
  currentWorkspaceId: string
}
```

---

## §2 · Workspaces

| Endpoint                                  | Purpose                                                                                                                           |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `GET /workspaces`                         | List workspaces user belongs to                                                                                                   |
| `POST /workspaces`                        | Create new workspace                                                                                                              |
| `GET /workspaces/:id`                     | Full workspace info                                                                                                               |
| `PATCH /workspaces/:id`                   | Update name/settings                                                                                                              |
| `DELETE /workspaces/:id`                  | Hard-delete workspace (owner-only; rejects with 409 `WORKSPACE_HAS_JOBS_WITH_HISTORY` if any job has `run_count > 0` per §11 §8). |
| `POST /workspaces/switch`                 | `{ workspaceId }` → validate membership and return `{ currentWorkspaceId }`. The client stores that marker locally and sends `X-Workspace-Id` on workspace-scoped requests; the session token itself is not re-minted for the workspace. |
| `POST /workspaces/:id/invite`             | Invite member by email                                                                                                            |
| `GET /workspaces/:id/members`             | List members                                                                                                                      |
| `PATCH /workspaces/:id/members/:userId`   | `{ role: 'owner' \| 'admin' \| 'member' }` — role update (admin-only; cannot demote the last owner).                              |
| `DELETE /workspaces/:id/members/:userId`  | Remove member (admin-only; cannot remove the owner).                                                                              |
| `POST /workspaces/:id/transfer-ownership` | `{ newOwnerUserId }` — single atomic txn that flips the prior owner to `admin` and promotes the target to `owner`. Owner-only.    |

**On workspace creation:** seed the 5 default agents and 3 default team compositions (see `03-agents.md`).

---

## §3 · Folders

| Endpoint                                     | Purpose                                                            |
| -------------------------------------------- | ------------------------------------------------------------------ |
| `GET /folders`                               | All folders in workspace                                           |
| `POST /folders`                              | `{ title }` → new folder                                           |
| `PATCH /folders/:id`                         | Rename single folder (or change `sortOrder`)                       |
| `PATCH /folders/order`                       | `{ folders: [{ id, sortOrder }] }` — batch reorder in a single txn |
| `DELETE /folders/:id?with_talks=true\|false` | Delete; optional cascade                                           |

---

## §4 · Talks

### `GET /talks?folder=<id>|unfiled|all&include_archived=false`

```ts
{
  talks: [{
    id, workspaceId, folderId, title,
    mode: 'Ordered' | 'Parallel',
    rounds, team: [agentId],
    tools: { [toolId]: boolean },
    running: boolean,
    unread: number,
    archivedAt: null | string,
    lastActivityAt: string,
    primaryDocumentId: string | null,
    messageCount: number,
  }],
  nextCursor: string | null
}
```

### `POST /talks`

```ts
// Request
{
  title?: string,           // auto-derives from first message if omitted
  folderId?: string,        // null/omitted → Unfiled
  team: [agentId],          // 1-5 agent IDs
  mode: 'Ordered' | 'Parallel',
  rounds: 1 | 2 | 3 | 5,
  tools?: { [toolId]: boolean },
  initialPrompt?: string,   // if present, also creates first user message and kicks off round 1
}

// Response
{
  talk: Talk,
  initialRun?: Run   // populated if initialPrompt was sent
}
```

### `GET /talks/:id`

Full talk with messages.

### `PATCH /talks/:id`

Partial update — `title`, `folderId`, `mode`, `rounds`, `tools`, `team`, `sortOrder`. `team` is full-replace shorthand; prefer the dedicated roster endpoints below for surgical changes (they preserve `talk_agents.sort_order` per agent).

### Talk roster endpoints (per §11 §3 `talk_agents`)

| Endpoint                            | Purpose                                                                                                                                     |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /talks/:id/agents`            | `{ agentId }` → append agent to roster (next `sort_order`). 409 `ROSTER_DUPLICATE` if already present, 409 `ROSTER_FULL` at 5 agents.       |
| `DELETE /talks/:id/agents/:agentId` | Remove agent from roster. Existing scheduled jobs targeting this agent will flip to `status='blocked'` at next fire (per §12 §5 dep check). |
| `PATCH /talks/:id/agents/order`     | `{ agents: [{ agentId, sortOrder }] }` — batch reorder in a single txn. Rejects unknown agentIds.                                           |

### `POST /talks/:id/archive`

```ts
{
  alsoArchiveDoc: boolean;
}
// Returns 204
```

### `POST /talks/:id/duplicate`

Returns a new Talk with copied user messages, fresh agent run state.

### `POST /talks/:id/messages`

User sends a message. Triggers a run for each agent in the team (Ordered → sequential, Parallel → fan out).

```ts
// Request
{ content: string, targetAgentIds?: string[] }

// Response (202)
{
  message: UserMessage,
  runs: [{ id, agentId, runStatus: 'queued', queuePosition: number }]
}
```

Subscribe to the WebSocket stream (§9) to receive `run.update` events.

Message attachments are not part of the active greenfield contract. The legacy
`/talks/:id/attachments` compatibility routes return `attachments_not_available`
until a future R2-backed attachment slice lands; use context file uploads for
source material. Current compatibility code may still accept or emit synthetic
`threadId`; native API consumers should not depend on it.

### `POST /talks/:id/cancel-runs`

Cancels every in-flight or queued run on this Talk.

---

## §5 · Messages & runs

```ts
type Message = UserMessage | AgentMessage;

type UserMessage = {
  id: string;
  role: 'user';
  authorUserId: string;
  text: string;
  createdAt: string;
  round: number;
};

type AgentMessage = {
  id: string;
  role: 'agent';
  agentId: string;
  runId: string;
  runStatus:
    | 'queued'
    | 'running'
    | 'awaiting'
    | 'completed'
    | 'failed'
    | 'cancelled';
  queuePosition?: number; // when queued
  text?: string; // when completed
  streamingText?: string; // when running (partial)
  progress?: string; // when running ("Reading 3 comps · synthesizing")
  tokens?: { in: number; out: number };
  toolCalls?: ToolCall[]; // tools the agent invoked during this run
  createdAt: string;
  round: number;
};

type ToolCall = {
  id: string;
  toolId: string;
  args: object;
  result?: object;
  durationMs: number;
};
```

### `GET /talks/:id/messages?after=<msgId>&limit=50`

Paginated. Most recent first by default.

---

## §6 · Agents

| Endpoint                 | Purpose                                                  |
| ------------------------ | -------------------------------------------------------- |
| `GET /agents`            | All agents in workspace                                  |
| `GET /agents/:id`        | Single agent                                             |
| `PATCH /agents/:id`      | Update name / model / persona / focus / method / enabled |
| `POST /agents/:id/reset` | Reset to defaults                                        |
| `GET /agents/:id/stats`  | Recent contributions across Talks                        |

```ts
type Agent = {
  id;
  workspaceId;
  roleKey;
  name;
  handle;
  initials;
  accent;
  model: string;
  defaultModel: string;
  job: string; // read-only role description
  persona: string; // editable tone/voice
  focus: string; // editable domain/topic emphasis
  method: string[]; // editable visible reasoning moves
  capabilities: string[];
  isCustom: boolean;
  enabled: boolean;
};
```

Raw system prompt editing and custom-agent creation are out of scope for v1.
See `06-agent-system-design.md` for agent storage, prompt assembly, snapshots,
and evals.

---

## §7 · Team compositions

| Endpoint                       | Purpose                                 |
| ------------------------------ | --------------------------------------- |
| `GET /teams`                   | All teams in workspace                  |
| `POST /teams`                  | Create from agentIds + name             |
| `PATCH /teams/:id`             | Update                                  |
| `DELETE /teams/:id`            | Delete                                  |
| `POST /talks/:id/save-as-team` | `{ name }` → snapshot current Talk team |

---

## §8 · Documents

| Endpoint                                                 | Purpose                                                     |
| -------------------------------------------------------- | ----------------------------------------------------------- |
| `GET /documents?include_unlinked=true`                   | All docs in workspace                                       |
| `POST /documents`                                        | `{ title, format, primaryTalkId?, folderId?, tabs? }` → new |
| `GET /documents/:id`                                     | Full doc with blocks                                        |
| `PATCH /documents/:id`                                   | Update title / format / primary Talk / folder               |
| `DELETE /documents/:id`                                  | Hard delete (no archive for docs in v1)                     |
| `POST /documents/:id/tabs`                               | `{ title }` → new document tab                              |
| `PATCH /documents/:id/tabs/:tabId`                       | Rename / reorder tab                                        |
| `DELETE /documents/:id/tabs/:tabId?cascadePending=false` | Delete tab (see cascade rules below)                        |
| `PATCH /documents/:id/blocks/:blockId/move`              | Move block across tabs / reorder within a tab               |
| `POST /documents/:id/blocks/:blockId/accept`             | Accept a pending edit                                       |
| `POST /documents/:id/blocks/:blockId/reject`             | Reject a pending edit                                       |
| `POST /documents/:id/accept-all`                         | Bulk accept                                                 |
| `POST /documents/:id/reject-all`                         | Bulk reject                                                 |

### `DELETE /documents/:id/tabs/:tabId`

Requires document to have 2+ tabs. Default (`?cascadePending=false`, or omitted):

- Returns **409 `TAB_HAS_PENDING_EDITS`** if any `document_edits.tab_id = :tabId` row has `status='pending'`. Response body lists the offending edit IDs so the UI can prompt the user.

With `?cascadePending=true`:

- Drops the tab and lets the `document_edits.tab_id` `ON DELETE CASCADE` (§11 §5) silently delete every pending edit on that tab. **The UI MUST show a confirmation dialog before sending `cascadePending=true`** (see `08-information-architecture.md` §6.3).

Returns 204 on success.

### `PATCH /documents/:id/blocks/:blockId/move`

Move a block to another tab or reorder it within its current tab.

```ts
// Request
{
  targetTabId: string,          // tab the block should live under (may equal current tab)
  afterBlockId?: string | null, // null → place at start of target tab
  baseListVersionSource: number,// source tab's list_version the client last saw
  baseListVersionTarget: number // target tab's list_version the client last saw
}

// Response (200)
{
  block: DocBlock,              // with updated tabId / sort_order
  sourceTab: { id, listVersion: number },
  targetTab: { id, listVersion: number }
}
```

Updates `doc_blocks.tab_id` and `sort_order`, then bumps **both** the source tab's and target tab's `list_version` (per §11 §5 CAS rules). Same-tab reorder bumps `list_version` once.

Errors:

- **409 `LIST_VERSION_CONFLICT`** — either base version is stale; client refetches and retries.
- **404 `BLOCK_NOT_FOUND`** — block was deleted or moved by another writer.
- **400 `TAB_MISMATCH`** — `afterBlockId` doesn't belong to `targetTabId`.

```ts
type DocTab = {
  id: string;
  documentId: string;
  title: string;
  order: number;
  blocks: DocBlock[];
};
type DocBlock = {
  id: string;
  tabId: string;
  kind: 'h1' | 'h2' | 'p' | 'li' | 'meta' | 'code';
  text: string;
  pending: boolean;
  pendingBy?: AgentId; // who proposed this edit
};
```

Document creation creates one default tab named `Main` when `tabs` is omitted.
Blocks are always scoped to a tab.

---

## §9 · WebSocket — streaming protocol

Connect: `wss://api.clawtalk.app/v1/stream?workspace=<wid>` with `Authorization` header on the upgrade.

Server pushes events; client may send a few control messages.

### Server → client

```ts
// Streaming token chunk
{
  type: 'run.delta',
  runId, talkId, messageId, agentId,
  delta: string,          // characters to append to streamingText
  tokensSoFar: number
}

// Status transitions
{
  type: 'run.status',
  runId, talkId, messageId,
  status: 'queued' | 'running' | 'awaiting' | 'completed' | 'failed' | 'cancelled',
  details?: object
}

// Tool invocation
{
  type: 'run.tool-call',
  runId, talkId, messageId,
  toolCall: ToolCall
}

// Full message commit (use to replace streamingText with final text)
{
  type: 'message.commit',
  messageId, talkId,
  message: AgentMessage   // with final text + tokens
}

// Doc edit proposed by an agent
{
  type: 'doc.pending-edit',
  docId, tabId, blockId,
  pendingBy: agentId,
  block: DocBlock
}

// Talk-level state changes
{
  type: 'talk.state',
  talkId,
  patch: Partial<Talk>    // running flag, unread count, etc.
}

// Inbox arrival (new home_inbox_items row for this workspace, §11 §7)
{
  type: 'inbox.new',
  item: InboxItem        // shape per §13 GET /home/inbox items[]
}

// Inbox row mutated (status flip, snooze, resolve, dedupe collapse)
{
  type: 'inbox.updated',
  itemId: string,
  patch: Partial<InboxItem>
}

// Home recommendations list changed for this workspace
// Fires after refresh, generator-driven invalidation, or any rerank.
{
  type: 'home.recommendations_changed',
  algorithmVersion: string,
  // Optional hint set when only a few rows changed; absent → full refetch.
  changedIds?: string[]
}

// --- Forge (§09 §9 / §11 §9) — all carry runId + workspace context ---

// One candidate landed and was scored against the audience.
{
  type: 'improvement_round_scored',
  runId, documentId, iteration: number,
  versionId, candidateId: string,
  compositeScore: number, heldOutScore: number,
  decision: 'keep' | 'discard' | 'frontier'
}

// A version was promoted to the frontier or named the running winner.
{
  type: 'improvement_version_kept',
  runId, versionId,
  iteration: number,
  reason: string,            // e.g. 'beat baseline', 'new frontier'
  bestVersionId: string      // current best for the run
}

// Run reached a terminal status.
{
  type: 'improvement_run_finished',
  runId,
  status: 'completed' | 'plateaued' | 'budget_exhausted' | 'cancelled' | 'failed',
  stopReason?: string,
  bestVersionId: string | null,
  baselineScore: number | null,
  bestScore: number | null
}

// --- Jobs (§12 §6) — these ALSO land as inbox.new on the originating workspace ---

// Successful run completion for a scheduled or manual job fire.
{
  type: 'job_output_ready',
  jobId, runId, talkId,
  emittedMessageId?: string, // present if emit_talk_message=true
  emittedEditId?: string,    // present if emit_document_append=true
  inboxItemId: string        // the home_inbox_items row, ref_id = runId
}

// Dependency check failed; job flipped to status='blocked'.
{
  type: 'job_blocked',
  jobId, talkId,
  blockReason: 'agent_missing' | 'model_disabled' | 'no_primary_document'
             | 'tool_not_enabled' | 'connector_not_authorized',
  inboxItemId: string        // ref_id = null per §11 §7 dedup rule
}
```

### Client → server

```ts
// Subscribe to a talk's stream
{
  type: ('subscribe', talkId);
}

// Unsubscribe
{
  type: ('unsubscribe', talkId);
}

// Heartbeat
{
  type: 'ping';
}
```

---

## §10 · Tools

Per-Talk tool state lives on the Talk. Workspace-level Tool catalog + connector configuration lives separately.

### `GET /workspace/tools`

Catalog of available tools with current connection status.

### `PATCH /talks/:id/tools`

```ts
{ tools: { 'web-search': true, 'gdrive-read': true, ... } }
```

### Tool IDs (v1)

`web-search` · `web-fetch` · `news-monitor` · `gdrive-read` · `gdrive-write` · `gmail-read` · `gmail-send` · `messaging` (Slack) · `linear` · `github-read`

---

## §11 · Connectors

Connectors are **workspace-global**, but not strictly one row per service: `connectors.service` is paired with an explicit compatibility surface in `config_json->>'compatSurface'`. OAuth-bearing runtime credentials use authorized rows such as `google_tools` (per user and per workspace for Google tool execution; it materializes the covered service rows, e.g. `gdrive` for Drive/Docs/Sheets scopes and `gmail` for Gmail scopes, backed by the same encrypted secret) and `slack_install` (per workspace Slack team, token in `connector_secrets`); Talk Drive resource catalogs use a separate unauthorized `talk_resource` singleton for the same `gdrive` service. Per-Talk scope lives in `connector_bindings` (workspace_id, connector_id, talk_id) — a separate, per-Talk binding so the same Slack/GDrive/etc. connection can be scoped differently per Talk (target channel, allowed scopes, enabled flag). See §11 §6 of `11-data-model.md`.

Cutover compatibility routes keep the current webapp API while writing final tables: `/api/v1/workspace/channels` accepts Slack only, `/api/v1/workspace/data-connectors` accepts Google Docs/Sheets only, `GET /api/v1/talks/:talkId/connectors` lists linkable Talk connectors, `PUT|DELETE /api/v1/talks/:talkId/connectors/channels/:channelId` and `PUT|DELETE /api/v1/talks/:talkId/connectors/data-connectors/:connectorId` toggle per-Talk connector links, and `/api/v1/talks/:talkId/resources` writes Talk Drive resource bindings. Google account credential routes (`/api/v1/me/google-account*`) require explicit workspace scope via `workspaceId`; picker-token may instead use `talkId` so the server resolves the credential workspace from the Talk before minting a Google Picker session. Google Docs/Sheets compatibility data connectors are config-only workspace sources: they can be linked to a Talk without a connector secret; actual Google API execution still uses the acting user's `google_tools` OAuth credential.

### Workspace-global authorize

| Endpoint                                                         | Purpose                                                                                                             |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `GET /workspace/connectors`                                      | List workspace connectors + their bindings                                                                          |
| `POST /workspace/connectors/:service/oauth-start`                | Start OAuth, returns `{ redirectUrl, state }`                                                                       |
| `GET /workspace/connectors/:service/oauth-callback?code=&state=` | OAuth callback. Persists token in `connector_secrets`, sets `connectors.authorized=true`. Returns 302 to the SPA.   |
| `POST /workspace/connectors/:service/revoke`                     | Revoke token. Sets `connectors.authorized=false`, clears `secret_ref`. Bindings remain (re-authorize to re-enable). |

```ts
// GET /workspace/connectors response
[{
  id, service: 'slack' | 'gdrive' | 'gmail' | 'linear' | 'github' | 'notion',
  authorized: boolean,
  authorizedAt: string | null,
  bindings: [{
    id,
    talkId,
    target: string | null,
    scope: string[],
    enabled: boolean,
    displayName: string | null,
    meta: Record<string, unknown>
  }]
}]
```

### Per-Talk binding

| Endpoint                                   | Purpose                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /talks/:id/connectors`                | Bindings for this Talk only                                                                                                                                                                                                                                                                             |
| `POST /talks/:id/connectors/:service/bind` | `{ target?, scope?: string[] }` → create or upsert a `connector_bindings` row for this Talk. Requires workspace connector to be authorized; 409 `CONNECTOR_NOT_AUTHORIZED` otherwise. Config-only Google Docs/Sheets compatibility sources are considered linkable once a workspace admin creates them. |
| `PATCH /talks/:id/connectors/:bindingId`   | Update `target` / `scope` / `enabled`.                                                                                                                                                                                                                                                                  |
| `DELETE /talks/:id/connectors/:bindingId`  | Remove the binding (does not revoke the workspace connector).                                                                                                                                                                                                                                           |

---

## §12 · Context sources

Per-Talk context (supporting documents, URLs, files, past Talks, house rules, News items) lives separately from messages — it's what agents read _from_, not what they say. A Talk's primary document is projected into this API for display, but the source of truth is `documents.primary_talk_id`.

### `GET /talks/:id/context`

```ts
[
  {
    id,
    kind:
      'primary_document' |
      'document' |
      'url' |
      'file' |
      'past_talk' |
      'rule' |
      'news',
    name,
    meta,
    addedAt,
  },
];
```

### `POST /talks/:id/context`

```ts
{
  (kind, name, meta, payload);
} // payload depends on kind
// Supporting document context:
// { kind: 'document', payload: { documentId, includeInPrompt: true } }
```

### `DELETE /talks/:id/context/:contextId`

---

## §13 · Home

Home is specified in `07-homepage-system-design.md`. The API should treat Home
as deterministic state, ranking, and structured actions first. Model use is
optional copy polish/clustering behind the same contracts.

### `GET /home/summary`

Returns curator headline, stats, active Talk summary, and Inbox counts.

### `GET /home/recommendations`

```ts
[
  {
    id,
    kind,
    title,
    why,
    priority: 'decide' | 'improve' | 'tidy',
    score: number,
    confidence: number,
    provenance: object,
    action: { type: string, payload: object },
    status: 'active' | 'dismissed' | 'completed' | 'expired' | 'snoozed',
    algorithmVersion: string,
    createdAt: string,
    expiresAt: string,
  },
];
```

Recommendations are generated from deterministic candidates and ranked from
workspace state. The Curator may rewrite copy or cluster cards behind a feature
flag, but it does not emit arbitrary user-visible cards.

### `POST /home/recommendations/refresh`

Regenerate deterministic candidates and rerank cached state.

### `POST /home/recommendations/:id/action`

Validate and execute the structured action.

### `POST /home/recommendations/:id/dismiss`

### `POST /home/recommendations/:id/feedback`

### `GET /home/news`

```ts
[{
  id, headline, source, favicon, age, excerpt,
  url,
  talkId,
  matchedOn: string[],
  whyItMatters: string,
  impact: 'changes_assumption' | 'adds_evidence' | 'updates_competitor' | 'introduces_risk' | 'provides_tactic' | 'background_only',
  score: number,
  publishedAt: string,
  algorithmVersion: string
}]
```

News matcher pulls privacy-safe topic profiles from Talks where the
`news-monitor` tool is enabled. External providers receive only abstracts,
keywords, entities, domains, and negative terms. They never receive raw message
or document content.

### `POST /home/news/refresh`

Queues News refresh jobs and returns cached results.

### `POST /home/news/:id/add-to-context`

### `POST /home/news/:id/opened`

### `POST /home/news/:id/snooze`

### `POST /home/news/:id/feedback`

### `GET /home/inbox?limit=20&cursor=`

Returns active Inbox items for Home and shell badges. Inbox items are arrivals,
blockers, and waiting states; they are not Talk rows.

```ts
{
  items: [{
    id: string,
    type: 'agent_replied' | 'round_completed' | 'agent_asks_user' | 'run_failed' | 'doc_edits_ready' | 'connector_needs_auth' | 'news_context_added' | 'long_running_run' | 'system_limit_reached' | 'forge_run_needs_review' | 'job_output_ready' | 'job_blocked',
    title: string,
    summary: string,
    reason: string,
    severity: 'info' | 'action' | 'blocking',
    status: 'unread' | 'read' | 'resolved' | 'dismissed' | 'snoozed' | 'expired',
    target: { kind: string, id?: string, talkId?: string, documentId?: string, runId?: string },
    primaryAction: { type: string, label: string, payload: object },
    secondaryActions: [{ type: string, label: string, payload: object }],
    score: number,
    createdAt: string,
    algorithmVersion: string
  }],
  counts: { unread: number, blocking: number, action: number, info: number },
  nextCursor: string | null,
  algorithmVersion: string
}
```

Use `GET /talks?folder=unfiled` for folderless Talks. Use this endpoint for
Inbox items.

### `POST /home/inbox/:id/read`

### `POST /home/inbox/:id/resolve`

### `POST /home/inbox/:id/dismiss`

### `POST /home/inbox/:id/snooze`

### `POST /home/inbox/:id/action`

---

## §14 · LLM provider abstraction

Don't bake calls to specific providers into routes. Abstract through one interface:

```ts
interface LLMProvider {
  name: string;
  models: string[];
  stream(args: {
    model: string;
    messages: ChatMessage[];
    temperature: number;
    tools?: ToolDefinition[];
    abortSignal?: AbortSignal;
  }): AsyncIterable<TokenDelta>;
}
```

Implement provider adapters for:

- **Anthropic** (Claude Opus 4.5, Sonnet 4.5) — streaming, tool use
- **OpenAI** (GPT-5 Pro, GPT-5 Mini) — streaming, function calling
- **Google** (Gemini 2.5 Pro) — streaming, grounding for `web-search`

Each agent's `model` field selects provider + model variant.

---

## §15 · Rate limiting & quotas

Per-workspace, per-day:

- Token budget by plan tier (configurable; defaults: Team = 200k/day, Enterprise = unmetered).
- Concurrent runs cap (default 5).
- Concurrent Talks streaming (default 3).

Per-user, per-minute:

- Messages sent (default 60/min).
- Talks created (default 20/min).

Surface remaining budget in `GET /me` and on the Home stat strip.

---

## §16 · Audit & analytics events

Log everything that mutates state. Minimum events:

- `talk.created`, `talk.archived`, `talk.moved`
- `folder.created`, `folder.deleted`
- `message.sent`, `run.started`, `run.completed`, `run.failed`
- `doc.created`, `doc.edited`, `doc.deleted`
- `agent.edited`, `agent.reset`
- `connector.bound`, `connector.unbound`
- `member.invited`, `member.removed`, `role.changed`

Include `actorId`, `workspaceId`, `entityId`, `payload`, `timestamp`. Stream to your analytics + audit log.

---

## §17 · Forge — improvement runs

Forge is the autonomous content-improvement loop (§09 / §11 §9). Runs reuse the standard run path (`run_kind='content_improvement'`), reuse `event_outbox` for streaming, and promote winners through the unified `document_edits` accept path with `source='forge'` — no second write path.

### Improvement runs

| Endpoint                                                          | Purpose                                          |
| ----------------------------------------------------------------- | ------------------------------------------------ |
| `POST /improvement-runs`                                          | Create a new improvement run                     |
| `GET /improvement-runs?documentId=&tabId=&status=&limit=&cursor=` | List (paginated)                                 |
| `GET /improvement-runs/:id`                                       | Detail                                           |
| `GET /improvement-runs/:id/versions?limit=&cursor=`               | Gallery — scored `document_versions` for the run |
| `POST /improvement-runs/:id/cancel`                               | Cancel an in-flight run                          |
| `GET /document-versions/:id`                                      | Single version detail                            |
| `POST /document-versions/:id/promote`                             | Promote winner via the standard accept path      |

#### `POST /improvement-runs`

```ts
// Request — scope: documentId required; whole-doc = tabId+targetBlockId both null; tab = tabId only; block = both.
{
  documentId: string,
  tabId?: string,
  targetBlockId?: string,
  audienceId?: string,                 // null → ad-hoc objective
  objectiveJson: {                     // resolved per §11 §9
    personaIds: string[],
    referenceSetId?: string,
    questionId?: string,
    scoringConfig: object,
    fitness: string                    // e.g. 'mean_composite'
  },
  searchConfigJson: {
    beamN: number, beamK: number,
    mutations: string[],
    plateauEpsilon: number
  },
  targetScore?: number,
  maxIterations?: number,
  budgetUsd?: number
}

// Response (201)
{ run: ImprovementRun }                // the new improvement_runs row
```

Subscribe to the WebSocket stream (§9) for `improvement_round_scored` / `improvement_version_kept` / `improvement_run_finished`.

#### `GET /improvement-runs/:id`

```ts
{
  run: ImprovementRun,                 // includes objectiveJson, searchConfigJson, status, stopReason
  baseline: { versionId, score: number } | null,
  best: { versionId, score: number } | null,
  documentVersionsCount: number
}
```

#### `POST /document-versions/:id/promote`

Land the chosen version's body as a pending `document_edits` row through the unified accept path.

```ts
// Request — overrides apply only when the version was scored at a coarser scope than the desired landing site.
{
  tabId?: string,
  targetBlockId?: string
}

// Response (201)
{ editId: string }                     // the new pending document_edits row (status='pending', source='forge')
```

Errors:

- **409 `RUN_NOT_TERMINAL`** — the parent improvement_run hasn't reached a terminal status yet.
- **404 `DOCUMENT_VERSION_NOT_FOUND`**.

#### `POST /improvement-runs/:id/cancel`

Cancels an in-flight run. Returns 200 with the updated row, or 409 `RUN_ALREADY_TERMINAL` if the run is already in a terminal status.

### Audiences (workspace-scoped, first-class — §11 §9)

| Endpoint                      | Purpose                                                                              |
| ----------------------------- | ------------------------------------------------------------------------------------ |
| `GET /forge/audiences`        | List `forge_audiences` rows for the workspace                                        |
| `POST /forge/audiences`       | `{ name, note?, referenceSetId?, questionId?, personaIds: string[] }` → create       |
| `PATCH /forge/audiences/:id`  | Update any of the above fields                                                       |
| `DELETE /forge/audiences/:id` | Delete (cascades `forge_audience_personas`; `improvement_runs.audience_id` SET NULL) |

### Synced SSR assets (read-only cache; refresh via SSR sync job)

| Endpoint                    | Purpose                                       |
| --------------------------- | --------------------------------------------- |
| `GET /forge/personas`       | `forge_personas` rows for the workspace       |
| `GET /forge/reference-sets` | `forge_reference_sets` rows for the workspace |
| `GET /forge/questions`      | `forge_questions` rows for the workspace      |

### SSR OAuth (per workspace; admin-only — §11 §9 / D7)

| Endpoint                         | Purpose                                                                               |
| -------------------------------- | ------------------------------------------------------------------------------------- |
| `POST /forge/ssr/oauth-start`    | Begin OAuth, returns `{ redirectUrl, state }`                                         |
| `POST /forge/ssr/oauth-callback` | `{ code, state }` → persist token in `connector_secrets`, write `ssr_connections` row |
| `POST /forge/ssr/revoke`         | Revoke the token; sets `ssr_connections.secret_ref = null`                            |

---

## §18 · Jobs — scheduled single-agent prompts

A **Job** is a saved, scheduled run (§12). It fires a normal `conversation` run on its Talk with `runs.job_id` set and `runs.trigger='scheduler'` (or `'manual'` for run-now). History is `runs` filtered by `job_id`; there is no separate `job_runs` table.

### Jobs

| Endpoint                                         | Purpose                                                                                                                  |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `POST /talks/:talkId/jobs`                       | Create job on a Talk                                                                                                     |
| `GET /talks/:talkId/jobs?status=&archived=false` | List jobs on a Talk                                                                                                      |
| `GET /jobs/:id`                                  | Detail (includes `nextDueAt`, `lastRunStatus`, `runCount`, `blockReason`)                                                |
| `PATCH /jobs/:id`                                | Edit. Re-runs the §12 §5 step 2 dep check on save (the §12 §6 unblock path)                                              |
| `POST /jobs/:id/pause`                           | Set `status='paused'`, `next_due_at=null`                                                                                |
| `POST /jobs/:id/resume`                          | Set `status='active'`, recompute `next_due_at` from now. 409 `JOB_BLOCKED` if `status='blocked'` (resolve the dep first) |
| `POST /jobs/:id/archive`                         | Soft archive: `archived_at=now()`, `next_due_at=null`. Run history stays queryable                                       |
| `POST /talks/:talkId/jobs/:jobId/run-now`        | Manual fire (§12 §6)                                                                                                     |
| `GET /jobs/:id/runs?limit=&cursor=`              | Run history — `runs` filtered by `job_id`, newest first                                                                  |

Job create requires Talk job-edit access (workspace owner/admin or Talk creator) and always sets `jobs.created_by` to the caller. Edit, pause, resume, and archive require Talk job-edit access so owner/admin users can manage orphaned schedules. Manual run-now still requires the job creator because `jobs.created_by` is the execution principal for frozen tool permissions and per-user Google credentials.

#### `POST /talks/:talkId/jobs`

```ts
// Request
{
  title: string,
  prompt: string,
  agentId: string,                     // must be on talk_agents for this Talk (enforced by §11 §8 trigger)
  scheduleJson:                        // §12 §4
    | { kind: 'interval', everyHours: number }
    | { kind: 'daily',  hour: number, minute: number }
    | { kind: 'weekly', weekdays: number[], hour: number, minute: number },
  timezone: string,                    // IANA; required even for interval (DST-safe wall-clock)
  emitTalkMessage: boolean,            // defaults true
  emitDocumentAppend: boolean,         // defaults false
  // Must satisfy emitTalkMessage || emitDocumentAppend (§11 §8 CHECK).
  sourceScopeJson: {
    allowWeb: boolean,
    toolIds: string[]                  // validated against talk_tools and runtime support (§12 §5); Gmail job tools are blocked until the Gmail executor ships
  },
  catchUp: 'skip' | 'run_once'         // §12 §4
}

// Response (201)
{ job: Job }                           // status='active', next_due_at set to first slot
```

#### `POST /talks/:talkId/jobs/:jobId/run-now`

Creates a `trigger='manual'` run per §12 §6. Allowed when `status in ('active','paused')` and the caller is `jobs.created_by`.

```ts
// Response (202)
{
  run: Run;
} // status='queued'

// Errors
// 409 RUN_BUSY — runs_one_active_per_job rejected (a non-terminal run already exists for this job).
// 400 JOB_BLOCKED — status='blocked'; user must edit the job first to clear block_reason.
```

#### `PATCH /jobs/:id`

Accepts any subset of: `title`, `prompt`, `agentId`, `scheduleJson`, `timezone`, `emitTalkMessage`, `emitDocumentAppend`, `sourceScopeJson`, `catchUp`. On save, the handler re-runs the §12 §5 step 2 dependency check; if the job was `blocked` and all deps now pass, the handler flips `status='active'` and recomputes `next_due_at` from now. If deps still fail, the edit lands but `block_reason` is updated to reflect the remaining failure.
