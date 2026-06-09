import { getDbPg, withUserContext } from '../../../db.js';
import {
  cancelGreenfieldTalkRuns,
  enqueueGreenfieldChatTurn,
  type GreenfieldChatRunRecord,
} from '../../talks/greenfield-chat-accessors.js';
import type { GreenfieldMessageRecord } from '../../talks/greenfield-detail-accessors.js';
import {
  getGreenfieldTalk,
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

type NormalizedAttachment = {
  id: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  extractionStatus: 'pending' | 'ready' | 'failed';
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
): RouteResult<never> {
  return { statusCode, body: { ok: false, error: { code, message } } };
}

function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

function canEditTalkJobs(input: {
  workspace: WorkspaceSummaryRecord;
  talk: GreenfieldTalkRecord;
  userId: string;
}): boolean {
  return (
    input.workspace.role !== 'guest' &&
    (input.workspace.role === 'owner' ||
      input.workspace.role === 'admin' ||
      input.talk.created_by === input.userId)
  );
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
  options: { talkId?: string } | undefined,
  fn: (ctx: WorkspaceContext) => Promise<RouteResult<T>>,
): Promise<RouteResult<T>> {
  try {
    await ensureWorkspaceBootstrapForUser(auth.userId);
  } catch {
    return error(401, 'unauthorized', 'Session is not active.');
  }

  return withUserContext(auth.userId, async () => {
    if (!requestedWorkspaceId && options?.talkId) {
      const talkWorkspace = await resolveWorkspaceForTalk({
        userId: auth.userId,
        talkId: options.talkId,
      });
      if (talkWorkspace) return fn({ workspace: talkWorkspace });
    }

    const workspace = await resolveWorkspaceForUser({
      userId: auth.userId,
      requestedWorkspaceId,
    });
    if (!workspace) {
      return error(
        requestedWorkspaceId ? 403 : 404,
        requestedWorkspaceId ? 'workspace_forbidden' : 'workspace_not_found',
        requestedWorkspaceId
          ? 'Workspace is not available to this user.'
          : 'No workspace exists for this user.',
      );
    }
    return fn({ workspace });
  });
}

async function resolveWorkspaceForTalk(input: {
  userId: string;
  talkId: string;
}): Promise<WorkspaceSummaryRecord | undefined> {
  const db = getDbPg();
  const rows = await db<WorkspaceSummaryRecord[]>`
    select
      w.id,
      w.name,
      wm.role,
      upper(left(regexp_replace(w.name, '[^[:alnum:]]+', '', 'g'), 2)) as initials,
      w.created_at,
      w.updated_at
    from public.talks t
    join public.workspaces w
      on w.id = t.workspace_id
    join public.workspace_members wm
      on wm.workspace_id = w.id
     and wm.user_id = ${input.userId}::uuid
    where t.id = ${input.talkId}::uuid
    limit 1
  `;
  return rows[0];
}

function assertTalkId(talkId: string): RouteResult<never> | null {
  if (!isUuid(talkId)) {
    return error(400, 'invalid_talk_id', 'Talk id must be a UUID.');
  }
  return null;
}

function normalizeOptionalStringArray(
  value: unknown,
): { ok: true; values: string[] } | { ok: false } {
  if (value === undefined || value === null) return { ok: true, values: [] };
  if (!Array.isArray(value)) return { ok: false };
  if (!value.every((entry) => typeof entry === 'string')) {
    return { ok: false };
  }
  return {
    ok: true,
    values: Array.from(
      new Set(value.map((entry) => entry.trim()).filter(Boolean)),
    ),
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
  attachments: NormalizedAttachment[];
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

function mapRunStatus(
  status: GreenfieldChatRunRecord['status'],
):
  | 'queued'
  | 'running'
  | 'awaiting_confirmation'
  | 'cancelled'
  | 'completed'
  | 'failed' {
  return status === 'awaiting' ? 'awaiting_confirmation' : status;
}

function toRunApi(run: GreenfieldChatRunRecord): {
  id: string;
  responseGroupId: string | null;
  sequenceIndex: number | null;
  status: ReturnType<typeof mapRunStatus>;
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

export async function enqueueGreenfieldChatRoute(input: {
  auth: AuthContext;
  workspaceId?: string | null;
  talkId: string;
  content: unknown;
  targetAgentIds?: unknown;
  attachmentIds?: unknown;
}): Promise<
  RouteResult<{
    talkId: string;
    message: ReturnType<typeof toMessageApi>;
    runs: ReturnType<typeof toRunApi>[];
    forcedSerialReason: null;
  }>
> {
  const talkError = assertTalkId(input.talkId);
  if (talkError) return talkError;

  if (typeof input.content !== 'string') {
    return error(400, 'message_required', 'Message content is required');
  }
  const content = input.content.trim();
  if (!content) {
    return error(400, 'message_required', 'Message content is required');
  }
  if (content.length > 20_000) {
    return error(
      400,
      'message_too_large',
      'Message content exceeds 20000 characters',
    );
  }

  const normalizedTargetAgentIds = normalizeOptionalStringArray(
    input.targetAgentIds,
  );
  if (!normalizedTargetAgentIds.ok) {
    return error(
      400,
      'invalid_target_agent_id',
      'targetAgentIds must be an array of UUID strings.',
    );
  }
  const targetAgentIds = normalizedTargetAgentIds.values;
  if (!targetAgentIds.every(isUuid)) {
    return error(400, 'invalid_target_agent_id', 'Agent ids must be UUIDs.');
  }
  const normalizedAttachmentIds = normalizeOptionalStringArray(
    input.attachmentIds,
  );
  if (!normalizedAttachmentIds.ok) {
    return error(
      400,
      'invalid_attachment_id',
      'attachmentIds must be an array of strings.',
    );
  }
  const attachmentIds = normalizedAttachmentIds.values;
  if (attachmentIds.length > 0) {
    return error(
      400,
      'attachments_not_available',
      'Message attachments are not available on this route yet.',
    );
  }

  return withResolvedWorkspace(
    input.auth,
    input.workspaceId,
    { talkId: input.talkId },
    async (ctx) => {
      const writerError = requireWorkspaceWriter(ctx.workspace);
      if (writerError) return writerError;
      const result = await enqueueGreenfieldChatTurn({
        workspaceId: ctx.workspace.id,
        talkId: input.talkId,
        userId: input.auth.userId,
        content,
        targetAgentIds,
      });
      if (!result.ok) {
        if (result.reason === 'talk_not_found') {
          return error(404, 'talk_not_found', 'Talk not found.');
        }
        if (result.reason === 'talk_archived') {
          return error(
            409,
            'talk_archived',
            'Archived talks cannot receive new messages.',
          );
        }
        if (result.reason === 'talk_round_active') {
          return error(
            409,
            'talk_round_active',
            'Wait for the current round to finish or cancel it before sending another message.',
          );
        }
        if (result.reason === 'agent_model_not_found') {
          return error(
            409,
            'agent_model_not_found',
            'A selected agent references a model or provider that is not available.',
          );
        }
        return error(
          400,
          'talk_agent_not_found',
          'No valid talk agent is available for this talk.',
        );
      }
      return ok(
        {
          talkId: result.talkId,
          message: toMessageApi(result.message),
          runs: result.runs.map(toRunApi),
          forcedSerialReason: null,
        },
        202,
      );
    },
  );
}

export async function cancelGreenfieldChatRoute(input: {
  auth: AuthContext;
  workspaceId?: string | null;
  talkId: string;
}): Promise<
  RouteResult<{
    talkId: string;
    cancelledRuns: number;
  }>
> {
  const talkError = assertTalkId(input.talkId);
  if (talkError) return talkError;

  return withResolvedWorkspace(
    input.auth,
    input.workspaceId,
    { talkId: input.talkId },
    async (ctx) => {
      const writerError = requireWorkspaceWriter(ctx.workspace);
      if (writerError) return writerError;
      const talk = await getGreenfieldTalk({
        workspaceId: ctx.workspace.id,
        talkId: input.talkId,
      });
      if (!talk) return error(404, 'talk_not_found', 'Talk not found.');
      const cancelled = await cancelGreenfieldTalkRuns({
        workspaceId: ctx.workspace.id,
        talkId: input.talkId,
        userId: input.auth.userId,
        includeJobRuns: canEditTalkJobs({
          workspace: ctx.workspace,
          talk,
          userId: input.auth.userId,
        }),
      });
      if (cancelled.cancelledRuns === 0) {
        return error(
          404,
          'no_active_run',
          'No running or queued chat exists for this talk',
        );
      }
      return ok({
        talkId: input.talkId,
        cancelledRuns: cancelled.cancelledRuns,
      });
    },
  );
}
