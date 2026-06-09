import { getDbPg, withUserContext } from '../../../db.js';
import {
  getGreenfieldDocumentForTalk,
  getGreenfieldRunContextRecord,
  getGreenfieldThreadMetrics,
  getTalkEventHighWater,
  listGreenfieldMessages,
  listGreenfieldRuns,
  searchGreenfieldMessages,
  deleteGreenfieldMessages,
  listPendingGreenfieldDocumentEdits,
  type GreenfieldDocumentEditRecord,
  type GreenfieldDocumentRecord,
  type GreenfieldMessageRecord,
  type GreenfieldRunContextRecord,
  type GreenfieldRunRecord,
  type GreenfieldThreadMetrics,
} from '../../talks/greenfield-detail-accessors.js';
import type { TalkRunContextDetails } from '../../talks/talk-run-context.js';
import {
  getGreenfieldTalk,
  listGreenfieldTalkAgents,
  type GreenfieldTalkAgentRecord,
  type GreenfieldTalkRecord,
} from '../../talks/greenfield-accessors.js';
import {
  resolveWorkspaceForUser,
  type WorkspaceSummaryRecord,
} from '../../workspaces/accessors.js';
import { ensureWorkspaceBootstrapForUser } from '../../workspaces/bootstrap.js';
import type { ApiEnvelope, AuthContext } from '../types.js';

type RouteResult<T> = {
  statusCode: number;
  body: ApiEnvelope<T>;
};

type WorkspaceContext = {
  workspace: WorkspaceSummaryRecord;
};

type WorkspaceResolutionScope = {
  talkId?: string | null;
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function ok<T>(data: T, statusCode = 200): RouteResult<T> {
  return { statusCode, body: { ok: true, data } };
}

function error(
  statusCode: number,
  code: string,
  message: string,
  details?: unknown,
): RouteResult<never> {
  return {
    statusCode,
    body: { ok: false, error: { code, message, details } },
  };
}

function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

function requireWorkspaceWriter(
  workspace: WorkspaceSummaryRecord,
): RouteResult<never> | null {
  if (workspace.role !== 'guest') return null;
  return error(
    403,
    'workspace_writer_required',
    'Workspace write access is required.',
  );
}

async function withResolvedWorkspace<T>(
  auth: AuthContext,
  requestedWorkspaceId: string | null | undefined,
  scope: WorkspaceResolutionScope | null,
  fn: (ctx: WorkspaceContext) => Promise<RouteResult<T>>,
): Promise<RouteResult<T>> {
  if (scope?.talkId && !isUuid(scope.talkId)) {
    return error(400, 'invalid_talk_id', 'Talk id must be a UUID.');
  }
  try {
    await ensureWorkspaceBootstrapForUser(auth.userId);
  } catch {
    return error(401, 'unauthorized', 'Session is not active.');
  }

  return withUserContext(auth.userId, async () => {
    const scopedWorkspaceId =
      requestedWorkspaceId ??
      (await findVisibleWorkspaceIdForScope({
        userId: auth.userId,
        scope,
      }));
    const workspace = await resolveWorkspaceForUser({
      userId: auth.userId,
      requestedWorkspaceId: scopedWorkspaceId,
    });
    if (!workspace) {
      return error(
        scopedWorkspaceId ? 403 : 404,
        scopedWorkspaceId ? 'workspace_forbidden' : 'workspace_not_found',
        scopedWorkspaceId
          ? 'Workspace is not available to this user.'
          : 'No workspace exists for this user.',
      );
    }
    return fn({ workspace });
  });
}

async function findVisibleWorkspaceIdForScope(input: {
  userId: string;
  scope: WorkspaceResolutionScope | null;
}): Promise<string | undefined> {
  if (!input.scope) return undefined;
  const db = getDbPg();
  if (input.scope.talkId) {
    const rows = await db<{ workspace_id: string }[]>`
      select t.workspace_id
      from public.talks t
      join public.workspace_members wm
        on wm.workspace_id = t.workspace_id
       and wm.user_id = ${input.userId}::uuid
      where t.id = ${input.scope.talkId}::uuid
      limit 1
    `;
    return rows[0]?.workspace_id;
  }
  return undefined;
}

function toSnapshotThreadApi(
  talk: GreenfieldTalkRecord,
  metrics: GreenfieldThreadMetrics,
): {
  id: string;
  talkId: string;
  title: string | null;
  isDefault: boolean;
  isInternal: boolean;
  isPinned: boolean;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  lastMessageAt: string | null;
} {
  return {
    id: talk.id,
    talkId: talk.id,
    title: metrics.title,
    isDefault: true,
    isInternal: false,
    isPinned: true,
    createdAt: metrics.created_at,
    updatedAt: metrics.updated_at,
    messageCount: metrics.message_count,
    lastMessageAt: metrics.last_message_at,
  };
}

function toMessageApi(message: GreenfieldMessageRecord): {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  createdBy: string | null;
  createdAt: string;
  runId: string | null;
  agentId: string | null;
  agentNickname: string | null;
  metadata: Record<string, unknown> | null;
  attachments: Array<{
    id: string;
    fileName: string;
    fileSize: number;
    mimeType: string;
    extractionStatus: 'pending' | 'ready' | 'failed';
  }>;
} {
  return {
    id: message.id,
    role: message.author_kind === 'agent' ? 'assistant' : 'user',
    content: message.body ?? '',
    createdBy: message.author_user_id,
    createdAt: message.created_at,
    runId: message.run_id,
    agentId: message.agent_id,
    agentNickname: message.agent_name,
    metadata: {
      round: message.round,
      authorKind: message.author_kind,
      agentRole: message.agent_role_key,
    },
    attachments: [],
  };
}

function toSearchResult(message: GreenfieldMessageRecord): {
  messageId: string;
  threadTitle: string | null;
  role: 'user' | 'assistant' | 'system' | 'tool';
  createdAt: string;
  preview: string;
} {
  return {
    messageId: message.id,
    threadTitle: null,
    role: message.author_kind === 'agent' ? 'assistant' : 'user',
    createdAt: message.created_at,
    preview: (message.body ?? '').replace(/\s+/g, ' ').slice(0, 240),
  };
}

function mapRunStatus(
  status: GreenfieldRunRecord['status'],
):
  | 'queued'
  | 'running'
  | 'awaiting_confirmation'
  | 'cancelled'
  | 'completed'
  | 'failed' {
  return status === 'awaiting' ? 'awaiting_confirmation' : status;
}

function toRunApi(run: GreenfieldRunRecord): {
  id: string;
  responseGroupId: string | null;
  sequenceIndex: number | null;
  status:
    | 'queued'
    | 'running'
    | 'awaiting_confirmation'
    | 'cancelled'
    | 'completed'
    | 'failed';
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  triggerMessageId: string | null;
  targetAgentId: string | null;
  targetAgentNickname: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  cancelReason: string | null;
  executorAlias: string | null;
  executorModel: string | null;
  providerId: string | null;
} {
  const errorInfo =
    run.error_json && typeof run.error_json === 'object'
      ? (run.error_json as Record<string, unknown>)
      : null;
  return {
    id: run.id,
    responseGroupId: run.response_group_id,
    sequenceIndex: run.sequence_index,
    status: mapRunStatus(run.status),
    createdAt: run.created_at,
    startedAt: run.started_at,
    completedAt: run.finished_at,
    triggerMessageId: run.trigger_message_id,
    targetAgentId: run.target_agent_id,
    targetAgentNickname: run.target_agent_name,
    errorCode:
      errorInfo && typeof errorInfo.code === 'string' ? errorInfo.code : null,
    errorMessage:
      errorInfo && typeof errorInfo.message === 'string'
        ? errorInfo.message
        : null,
    cancelReason: null,
    executorAlias: run.target_agent_name,
    executorModel: run.model_id,
    providerId: run.provider_id,
  };
}

function toSnapshotRunApi(run: GreenfieldRunRecord): {
  id: string;
  status: ReturnType<typeof mapRunStatus>;
  responseGroupId: string | null;
  sequenceIndex: number | null;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  triggerMessageId: string | null;
  targetAgentId: string | null;
  executorAlias: string | null;
  executorModel: string | null;
  providerId: string | null;
} {
  return {
    id: run.id,
    status: mapRunStatus(run.status),
    responseGroupId: run.response_group_id,
    sequenceIndex: run.sequence_index,
    createdAt: run.created_at,
    startedAt: run.started_at,
    endedAt: run.finished_at,
    triggerMessageId: run.trigger_message_id,
    targetAgentId: run.target_agent_id,
    executorAlias: run.target_agent_name,
    executorModel: run.model_id,
    providerId: run.provider_id,
  };
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function toPersonaRole(
  roleKey: string | null,
): TalkRunContextDetails['personaRole'] {
  switch (roleKey) {
    case 'assistant':
    case 'analyst':
    case 'critic':
    case 'strategist':
    case 'devils-advocate':
    case 'synthesizer':
    case 'editor':
      return roleKey;
    case 'researcher':
    case 'quant':
      return 'analyst';
    default:
      return null;
  }
}

function enabledRuntimeToolNames(value: unknown): string[] {
  const manifest = recordOf(value);
  const effectiveTools = manifest?.effectiveTools;
  if (!Array.isArray(effectiveTools)) return [];
  const names = new Set<string>();
  for (const entry of effectiveTools) {
    const tool = recordOf(entry);
    if (tool?.enabled !== true || !Array.isArray(tool.runtimeTools)) continue;
    for (const name of tool.runtimeTools) {
      if (typeof name === 'string' && name.trim()) names.add(name.trim());
    }
  }
  return Array.from(names).sort();
}

function toRunContextDetails(
  record: GreenfieldRunContextRecord,
): TalkRunContextDetails | null {
  if (!record.tool_manifest_json && !record.prompt_text_redacted) return null;
  const promptChars = record.prompt_text_redacted?.length ?? 0;
  return {
    version: 1,
    personaRole: toPersonaRole(record.role_key),
    prompt: {
      hasRedactedPrompt: Boolean(record.prompt_text_redacted),
      estimatedTokens: Math.ceil(promptChars / 4),
    },
    tools: {
      contextToolNames: enabledRuntimeToolNames(record.tool_manifest_json),
    },
    history: {
      triggerMessageId: record.trigger_message_id,
      turnCount: Math.max(0, record.round),
    },
  };
}

function toPrimaryDocumentApi(document: GreenfieldDocumentRecord): {
  id: string;
  talkId: string;
  title: string;
  format: 'markdown' | 'html';
  listVersion: number;
  createdAt: string;
  updatedAt: string;
} {
  return {
    id: document.id,
    talkId: document.primary_talk_id ?? '',
    title: document.title,
    format: document.format,
    listVersion: document.list_version,
    createdAt: document.created_at,
    updatedAt: document.updated_at,
  };
}

function toPendingEditApi(edit: GreenfieldDocumentEditRecord): {
  id: string;
  contentId: string;
  runId: string;
  agentId: string | null;
  agentNickname: string | null;
  messageId: string | null;
  kind: 'insert' | 'replace' | 'delete' | 'bulk';
  baseContentVersion: number;
  targetAnchorId: string | null;
  newMarkdown: string | null;
  rationale: string | null;
  createdAt: string;
} {
  return {
    id: edit.id,
    contentId: edit.document_id,
    runId: edit.proposed_by_run_id ?? '',
    agentId: edit.proposed_by_agent_id,
    agentNickname: edit.proposed_by_agent_name,
    messageId: null,
    kind: edit.op,
    baseContentVersion: edit.base_list_version ?? edit.base_block_version ?? 1,
    targetAnchorId: edit.op === 'insert' ? edit.after_block_id : edit.block_id,
    newMarkdown: edit.new_text,
    rationale: null,
    createdAt: edit.created_at,
  };
}

type SnapshotAccessRole = 'owner' | 'admin' | 'editor' | 'viewer';

function snapshotAccessRole(input: {
  talk: GreenfieldTalkRecord;
  workspace: WorkspaceSummaryRecord;
  userId: string;
}): SnapshotAccessRole {
  if (input.workspace.role === 'guest') return 'viewer';
  if (input.talk.created_by === input.userId) return 'owner';
  if (input.workspace.role === 'owner' || input.workspace.role === 'admin') {
    return 'admin';
  }
  return 'editor';
}

function toSnapshotTalk(input: {
  talk: GreenfieldTalkRecord;
  workspace: WorkspaceSummaryRecord;
  userId: string;
}): {
  id: string;
  workspaceId: string;
  ownerId: string;
  folderId: string | null;
  sortOrder: number;
  title: string | null;
  orchestrationMode: 'ordered' | 'panel';
  status: 'active' | 'paused' | 'archived';
  version: number;
  createdAt: string;
  updatedAt: string;
  accessRole: SnapshotAccessRole;
} {
  const { talk } = input;
  return {
    id: talk.id,
    workspaceId: input.workspace.id,
    ownerId: talk.created_by,
    folderId: talk.folder_id,
    sortOrder: talk.sort_order,
    title: talk.title,
    orchestrationMode: talk.mode === 'parallel' ? 'panel' : 'ordered',
    status: talk.archived_at ? 'archived' : 'active',
    version: 1,
    createdAt: talk.created_at,
    updatedAt: talk.updated_at,
    accessRole: snapshotAccessRole(input),
  };
}

function toSnapshotAgent(agent: GreenfieldTalkAgentRecord): {
  assignmentId: string;
  agentId: string;
  agentName: string;
  nickname: string;
  personaRole: string | null;
  isPrimary: boolean;
  sortOrder: number;
} {
  return {
    assignmentId: agent.id,
    agentId: agent.id,
    agentName: agent.name,
    nickname: agent.name,
    personaRole: agent.role_key,
    isPrimary: agent.sort_order === 0,
    sortOrder: agent.sort_order,
  };
}

async function loadTalkOr404(input: {
  workspaceId: string;
  talkId: string;
}): Promise<GreenfieldTalkRecord | RouteResult<never>> {
  if (!isUuid(input.talkId)) {
    return error(400, 'invalid_talk_id', 'Talk id must be a UUID.');
  }
  const talk = await getGreenfieldTalk(input);
  return talk ?? error(404, 'talk_not_found', 'Talk not found.');
}

export async function listGreenfieldMessagesRoute(input: {
  auth: AuthContext;
  workspaceId?: string | null;
  talkId: string;
  beforeCreatedAt?: string;
  limit?: number;
}): Promise<
  RouteResult<{
    talkId: string;
    messages: ReturnType<typeof toMessageApi>[];
    page: { limit: number; count: number; beforeCreatedAt: string | null };
  }>
> {
  return withResolvedWorkspace(
    input.auth,
    input.workspaceId,
    { talkId: input.talkId },
    async (ctx) => {
      const talk = await loadTalkOr404({
        workspaceId: ctx.workspace.id,
        talkId: input.talkId,
      });
      if ('statusCode' in talk) return talk;
      const limit = Math.min(Math.max(input.limit ?? 200, 1), 500);
      const messages = await listGreenfieldMessages({
        workspaceId: ctx.workspace.id,
        talkId: input.talkId,
        beforeCreatedAt: input.beforeCreatedAt,
        limit,
      });
      return ok({
        talkId: input.talkId,
        messages: messages.map(toMessageApi),
        page: {
          limit,
          count: messages.length,
          beforeCreatedAt: input.beforeCreatedAt ?? null,
        },
      });
    },
  );
}

export async function searchGreenfieldMessagesRoute(input: {
  auth: AuthContext;
  workspaceId?: string | null;
  talkId: string;
  query: string;
  limit?: number;
}): Promise<
  RouteResult<{
    talkId: string;
    query: string;
    results: ReturnType<typeof toSearchResult>[];
  }>
> {
  return withResolvedWorkspace(
    input.auth,
    input.workspaceId,
    { talkId: input.talkId },
    async (ctx) => {
      const talk = await loadTalkOr404({
        workspaceId: ctx.workspace.id,
        talkId: input.talkId,
      });
      if ('statusCode' in talk) return talk;
      const query = input.query.trim();
      if (!query) return ok({ talkId: input.talkId, query, results: [] });
      const messages = await searchGreenfieldMessages({
        workspaceId: ctx.workspace.id,
        talkId: input.talkId,
        query,
        limit: input.limit,
      });
      return ok({
        talkId: input.talkId,
        query,
        results: messages.map(toSearchResult),
      });
    },
  );
}

export async function deleteGreenfieldMessagesRoute(input: {
  auth: AuthContext;
  workspaceId?: string | null;
  talkId: string;
  messageIds: unknown;
}): Promise<
  RouteResult<{
    talkId: string;
    deletedCount: number;
    deletedMessageIds: string[];
  }>
> {
  return withResolvedWorkspace(
    input.auth,
    input.workspaceId,
    { talkId: input.talkId },
    async (ctx) => {
      const talk = await loadTalkOr404({
        workspaceId: ctx.workspace.id,
        talkId: input.talkId,
      });
      if ('statusCode' in talk) return talk;
      const writerError = requireWorkspaceWriter(ctx.workspace);
      if (writerError) return writerError;
      if (
        !Array.isArray(input.messageIds) ||
        input.messageIds.length === 0 ||
        input.messageIds.some((messageId) => typeof messageId !== 'string')
      ) {
        return error(
          400,
          'invalid_message_id',
          'Message ids must be a non-empty array of UUID strings.',
        );
      }
      if (!input.messageIds.every(isUuid)) {
        return error(400, 'invalid_message_id', 'Message ids must be UUIDs.');
      }
      const deletedIds = await deleteGreenfieldMessages({
        workspaceId: ctx.workspace.id,
        talkId: input.talkId,
        messageIds: input.messageIds,
      });
      return ok({
        talkId: input.talkId,
        deletedCount: deletedIds.length,
        deletedMessageIds: deletedIds,
      });
    },
  );
}

async function primaryDocumentPayload(input: {
  workspaceId: string;
  document: GreenfieldDocumentRecord | undefined;
}): Promise<{
  primaryDocument: ReturnType<typeof toPrimaryDocumentApi> | null;
  pendingEdits: ReturnType<typeof toPendingEditApi>[];
}> {
  if (!input.document) return { primaryDocument: null, pendingEdits: [] };
  const edits = await listPendingGreenfieldDocumentEdits({
    workspaceId: input.workspaceId,
    documentId: input.document.id,
  });
  return {
    primaryDocument: toPrimaryDocumentApi(input.document),
    pendingEdits: edits.map(toPendingEditApi),
  };
}

export async function listGreenfieldRunsRoute(input: {
  auth: AuthContext;
  workspaceId?: string | null;
  talkId: string;
}): Promise<
  RouteResult<{ talkId: string; runs: ReturnType<typeof toRunApi>[] }>
> {
  return withResolvedWorkspace(
    input.auth,
    input.workspaceId,
    { talkId: input.talkId },
    async (ctx) => {
      const talk = await loadTalkOr404({
        workspaceId: ctx.workspace.id,
        talkId: input.talkId,
      });
      if ('statusCode' in talk) return talk;
      const runs = await listGreenfieldRuns({
        workspaceId: ctx.workspace.id,
        talkId: input.talkId,
      });
      return ok({ talkId: input.talkId, runs: runs.map(toRunApi) });
    },
  );
}

export async function getGreenfieldRunContextRoute(input: {
  auth: AuthContext;
  workspaceId?: string | null;
  talkId: string;
  runId: string;
}): Promise<
  RouteResult<{
    talkId: string;
    runId: string;
    context: TalkRunContextDetails | null;
  }>
> {
  if (!isUuid(input.talkId)) {
    return error(400, 'invalid_talk_id', 'Talk id must be a UUID.');
  }
  if (!isUuid(input.runId)) {
    return error(400, 'invalid_run_id', 'Run id must be a UUID.');
  }
  return withResolvedWorkspace(
    input.auth,
    input.workspaceId,
    { talkId: input.talkId },
    async (ctx) => {
      const talk = await loadTalkOr404({
        workspaceId: ctx.workspace.id,
        talkId: input.talkId,
      });
      if ('statusCode' in talk) return talk;
      const contextRecord = await getGreenfieldRunContextRecord({
        workspaceId: ctx.workspace.id,
        talkId: input.talkId,
        runId: input.runId,
      });
      if (!contextRecord) {
        return error(404, 'run_not_found', 'Run not found.');
      }
      return ok({
        talkId: input.talkId,
        runId: input.runId,
        context: toRunContextDetails(contextRecord),
      });
    },
  );
}

export async function getGreenfieldSnapshotRoute(input: {
  auth: AuthContext;
  workspaceId?: string | null;
  talkId: string;
}): Promise<
  RouteResult<{
    talk: ReturnType<typeof toSnapshotTalk>;
    threads: ReturnType<typeof toSnapshotThreadApi>[];
    messages: ReturnType<typeof toMessageApi>[];
    hasOlderMessages: boolean;
    primaryDocument: ReturnType<typeof toPrimaryDocumentApi> | null;
    pendingEdits: ReturnType<typeof toPendingEditApi>[];
    runs: ReturnType<typeof toSnapshotRunApi>[];
    agents: ReturnType<typeof toSnapshotAgent>[];
    eventHighWater: number;
  }>
> {
  return withResolvedWorkspace(
    input.auth,
    input.workspaceId,
    { talkId: input.talkId },
    async (ctx) => {
      const talk = await loadTalkOr404({
        workspaceId: ctx.workspace.id,
        talkId: input.talkId,
      });
      if ('statusCode' in talk) return talk;
      // Outbox cursor for the client's streamed-message dedup. Read BEFORE
      // the message load so it stays a lower bound consistent with the
      // returned messages (see getTalkEventHighWater). MUST be the
      // event_outbox high-water (same scale as the streamed eventId), not a
      // wall-clock timestamp — otherwise every streamed reply is dropped and
      // vanishes from the live thread until a reload.
      const eventHighWater = await getTalkEventHighWater({
        talkId: input.talkId,
      });
      const [metrics, rawMessages, document, runs, agents] = await Promise.all([
        getGreenfieldThreadMetrics({
          workspaceId: ctx.workspace.id,
          talkId: input.talkId,
        }),
        listGreenfieldMessages({
          workspaceId: ctx.workspace.id,
          talkId: input.talkId,
          limit: 201,
        }),
        getGreenfieldDocumentForTalk({
          workspaceId: ctx.workspace.id,
          talkId: input.talkId,
        }),
        listGreenfieldRuns({
          workspaceId: ctx.workspace.id,
          talkId: input.talkId,
        }),
        listGreenfieldTalkAgents({
          workspaceId: ctx.workspace.id,
          talkId: input.talkId,
        }),
      ]);
      if (!metrics) return error(404, 'talk_not_found', 'Talk not found.');
      const messages =
        rawMessages.length > 200 ? rawMessages.slice(1) : rawMessages;
      const documentPayload = await primaryDocumentPayload({
        workspaceId: ctx.workspace.id,
        document,
      });
      return ok({
        talk: toSnapshotTalk({
          talk,
          workspace: ctx.workspace,
          userId: input.auth.userId,
        }),
        threads: [toSnapshotThreadApi(talk, metrics)],
        messages: messages.map(toMessageApi),
        hasOlderMessages: rawMessages.length > 200,
        primaryDocument: documentPayload.primaryDocument,
        pendingEdits: documentPayload.pendingEdits,
        runs: runs.map(toSnapshotRunApi),
        agents: agents.map(toSnapshotAgent),
        eventHighWater,
      });
    },
  );
}
