import { withUserContext } from '../../../db.js';
import {
  cancelGreenfieldTalkRuns,
  enqueueGreenfieldChatTurn,
  type GreenfieldChatRunRecord,
} from '../../talks/greenfield-chat-accessors.js';
import type { GreenfieldMessageRecord } from '../../talks/greenfield-detail-accessors.js';
import { getGreenfieldTalk } from '../../talks/greenfield-accessors.js';
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

async function withResolvedWorkspace<T>(
  auth: AuthContext,
  requestedWorkspaceId: string | null | undefined,
  fn: (ctx: WorkspaceContext) => Promise<RouteResult<T>>,
): Promise<RouteResult<T>> {
  try {
    await ensureWorkspaceBootstrapForUser(auth.userId);
  } catch {
    return error(401, 'unauthorized', 'Session is not active.');
  }

  return withUserContext(auth.userId, async () => {
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

function assertTalkAndThread(input: {
  talkId: string;
  threadId?: string | null;
}): RouteResult<never> | null {
  if (!isUuid(input.talkId)) {
    return error(400, 'invalid_talk_id', 'Talk id must be a UUID.');
  }
  if (!input.threadId || input.threadId === input.talkId) {
    return null;
  }
  return error(404, 'thread_not_found', 'Thread not found.');
}

function normalizeExtractionStatus(
  value: unknown,
): NormalizedAttachment['extractionStatus'] {
  if (value === 'ready' || value === 'failed') return value;
  return 'pending';
}

function normalizeAttachments(value: unknown): NormalizedAttachment[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is Record<string, unknown> => {
      return (
        Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry)
      );
    })
    .map(
      (entry): NormalizedAttachment => ({
        id: typeof entry.id === 'string' ? entry.id : '',
        fileName: typeof entry.fileName === 'string' ? entry.fileName : '',
        fileSize: typeof entry.fileSize === 'number' ? entry.fileSize : 0,
        mimeType:
          typeof entry.mimeType === 'string'
            ? entry.mimeType
            : 'application/octet-stream',
        extractionStatus: normalizeExtractionStatus(entry.extractionStatus),
      }),
    )
    .filter((entry) => entry.id);
}

function toMessageApi(message: GreenfieldMessageRecord): {
  id: string;
  threadId: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  createdBy: string | null;
  createdAt: string;
  runId: string | null;
  agentId: string | null;
  agentNickname: string | null;
  metadata: Record<string, unknown> | null;
  attachments: ReturnType<typeof normalizeAttachments>;
} {
  return {
    id: message.id,
    threadId: message.talk_id,
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
    attachments: normalizeAttachments(message.attachments_json),
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
  threadId: string;
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
} {
  const errorInfo =
    run.error_json && typeof run.error_json === 'object'
      ? (run.error_json as Record<string, unknown>)
      : null;
  return {
    id: run.id,
    threadId: run.talk_id,
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
  };
}

export async function enqueueGreenfieldChatRoute(input: {
  auth: AuthContext;
  workspaceId?: string | null;
  talkId: string;
  threadId?: string | null;
  content: string;
  targetAgentIds?: string[] | null;
  attachmentIds?: string[] | null;
}): Promise<
  RouteResult<{
    talkId: string;
    message: ReturnType<typeof toMessageApi>;
    runs: ReturnType<typeof toRunApi>[];
    forcedSerialReason: null;
  }>
> {
  const talkError = assertTalkAndThread({
    talkId: input.talkId,
    threadId: input.threadId,
  });
  if (talkError) return talkError;

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

  const targetAgentIds = Array.from(
    new Set(
      (input.targetAgentIds ?? []).map((id) => id.trim()).filter(Boolean),
    ),
  );
  if (!targetAgentIds.every(isUuid)) {
    return error(400, 'invalid_target_agent_id', 'Agent ids must be UUIDs.');
  }
  const attachmentIds = Array.from(
    new Set((input.attachmentIds ?? []).map((id) => id.trim()).filter(Boolean)),
  );
  if (attachmentIds.length > 0) {
    return error(
      400,
      'attachments_not_available',
      'Message attachments are not available on this route yet.',
    );
  }

  return withResolvedWorkspace(input.auth, input.workspaceId, async (ctx) => {
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
  });
}

export async function cancelGreenfieldChatRoute(input: {
  auth: AuthContext;
  workspaceId?: string | null;
  talkId: string;
  threadId?: string | null;
}): Promise<
  RouteResult<{
    talkId: string;
    threadId: string | null;
    cancelledRuns: number;
  }>
> {
  const talkError = assertTalkAndThread({
    talkId: input.talkId,
    threadId: input.threadId,
  });
  if (talkError) return talkError;

  return withResolvedWorkspace(input.auth, input.workspaceId, async (ctx) => {
    const talk = await getGreenfieldTalk({
      workspaceId: ctx.workspace.id,
      talkId: input.talkId,
    });
    if (!talk) return error(404, 'talk_not_found', 'Talk not found.');
    const cancelled = await cancelGreenfieldTalkRuns({
      workspaceId: ctx.workspace.id,
      talkId: input.talkId,
      userId: input.auth.userId,
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
      threadId: input.threadId ?? null,
      cancelledRuns: cancelled.cancelledRuns,
    });
  });
}
