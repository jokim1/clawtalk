import { getSupabaseClient, isSupabaseConfigured } from './supabase-client';
import { getActiveWorkspaceId, rememberActiveWorkspace } from './queryClient';

export class UnauthorizedError extends Error {
  constructor(message = 'Authentication is required') {
    super(message);
    this.name = 'UnauthorizedError';
  }
}

export class ApiError extends Error {
  status: number;
  code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export type SessionUser = {
  id: string;
  email: string;
  displayName: string;
  role: string;
  createdAt: string;
  workspaces?: SessionWorkspace[];
  currentWorkspaceId?: string;
};

export type SessionWorkspace = {
  id: string;
  name: string;
  role: string;
  initials: string;
};

export type Talk = {
  id: string;
  ownerId: string;
  title: string;
  orchestrationMode: 'ordered' | 'panel';
  agents: string[];
  status: string;
  folderId: string | null;
  sortOrder: number;
  version: number;
  createdAt: string;
  updatedAt: string;
  accessRole: 'owner' | 'admin' | 'editor' | 'viewer';
};

export type TalkSidebarTalk = {
  type: 'talk';
  id: string;
  title: string;
  status: string;
  sortOrder: number;
  lastMessageAt?: string | null;
  messageCount?: number;
  hasActiveRun?: boolean;
  hasContent?: boolean;
};

export type TalkSidebarFolder = {
  type: 'folder';
  id: string;
  title: string;
  sortOrder: number;
  talks: TalkSidebarTalk[];
};

export type TalkSidebarItem = TalkSidebarTalk | TalkSidebarFolder;

export type ContentSidebarItem = {
  id: string;
  talkId: string;
  threadId: string;
  title: string;
  updatedAt: string;
};

export type TalkSidebarTree = {
  items: TalkSidebarItem[];
  mainTalkId: string | null;
  contents: ContentSidebarItem[];
};

export type ContentFormat = 'markdown' | 'html';

export type Content = {
  id: string;
  talkId: string;
  threadId: string;
  title: string;
  contentKind: string;
  contentFormat: ContentFormat;
  bodyMarkdown: string;
  bodyHtml: string | null;
  bodyVersion: number;
  anchorMap: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  createdByUserId: string | null;
  updatedByUserId: string | null;
  updatedByRunId: string | null;
};

// ---------------------------------------------------------------------------
// Context tab types
// ---------------------------------------------------------------------------

export type ContextGoal = {
  goalText: string;
  updatedAt: string;
};

export type ContextRule = {
  id: string;
  ruleText: string;
  isActive: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
};

export type ContextSource = {
  id: string;
  sourceRef: string;
  sourceType: 'url' | 'file' | 'text';
  title: string;
  note: string | null;
  sourceUrl: string | null;
  fileName: string | null;
  fileSize: number | null;
  status: 'pending' | 'ready' | 'failed';
  extractedTextLength: number | null;
  extractedAt: string | null;
  isTruncated: boolean;
  extractionError: string | null;
  mimeType: string | null;
  lastFetchedAt: string | null;
  fetchStrategy: 'http' | 'browser' | 'managed' | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  // Rasterized-page state (PDF page-image feature). pageSetComplete is the
  // backend's resolved boolean — the webapp shows a "render pages"
  // affordance for PDFs where it is false. Surfaced, not recomputed.
  expectedPageCount: number | null;
  pageImageCount: number;
  pageSetComplete: boolean;
};

export type TalkContext = {
  goal: ContextGoal | null;
  rules: ContextRule[];
  sources: ContextSource[];
};

export type TalkJobWeekday =
  | 'sun'
  | 'mon'
  | 'tue'
  | 'wed'
  | 'thu'
  | 'fri'
  | 'sat';

export type TalkJobSchedule =
  | {
      kind: 'hourly_interval';
      everyHours: number;
    }
  | {
      kind: 'daily';
      hour: number;
      minute: number;
    }
  | {
      kind: 'weekly';
      weekdays: TalkJobWeekday[];
      hour: number;
      minute: number;
    };

export type TalkJobScope = {
  toolIds: string[];
  allowWeb: boolean;
};

export type TalkJob = {
  id: string;
  talkId: string;
  title: string;
  prompt: string;
  targetAgentId: string | null;
  targetAgentNickname: string | null;
  status: 'active' | 'paused' | 'blocked';
  schedule: TalkJobSchedule;
  timezone: string;
  sourceScope: TalkJobScope;
  threadId: string;
  lastRunAt: string | null;
  lastRunStatus: string | null;
  nextDueAt: string | null;
  runCount: number;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
};

export type TalkJobRunSummary = {
  id: string;
  threadId: string;
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
  responseExcerpt: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  cancelReason: string | null;
  executorAlias: string | null;
  executorModel: string | null;
};

export type TalkThread = {
  id: string;
  talkId: string;
  title: string | null;
  isDefault: boolean;
  isPinned: boolean;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  lastMessageAt: string | null;
};

export type TalkThreadUpdate = {
  id: string;
  talkId: string;
  title: string | null;
  isDefault: boolean;
  isPinned: boolean;
  createdAt: string;
  updatedAt: string;
};

export type TalkMessageAttachment = {
  id: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  extractionStatus: 'pending' | 'ready' | 'failed';
};

export type TalkMessage = {
  id: string;
  threadId: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  createdBy: string | null;
  createdAt: string;
  runId: string | null;
  agentId?: string | null;
  agentNickname?: string | null;
  metadata?: Record<string, unknown> | null;
  attachments?: TalkMessageAttachment[];
};

export type TalkMessageSearchResult = {
  messageId: string;
  threadId: string;
  threadTitle: string | null;
  role: 'user' | 'assistant' | 'system' | 'tool';
  createdAt: string;
  preview: string;
};

export type BrowserBlockedKind =
  | 'auth_required'
  | 'confirmation_required'
  | 'human_step_required'
  | 'session_conflict';

export type BrowserBlockArtifact = {
  attachmentId?: string | null;
  path?: string | null;
  fileName?: string | null;
  contentType?: string | null;
  label?: string | null;
};

export type BrowserPendingToolCall = {
  toolName: string;
  args: Record<string, unknown>;
};

export type BrowserBlock = {
  kind: BrowserBlockedKind;
  sessionId: string | null;
  siteKey: string;
  accountLabel: string | null;
  conflictingRunId?: string | null;
  conflictingSessionId?: string | null;
  conflictingRunSummary?: string | null;
  url: string;
  title: string;
  message: string;
  riskReason: string | null;
  setupCommand: string | null;
  artifacts: BrowserBlockArtifact[];
  confirmationId: string | null;
  pendingToolCall: BrowserPendingToolCall | null;
  createdAt: string;
  updatedAt: string;
};

export type BrowserResume = {
  kind:
    | 'auth_completed'
    | 'confirmation_approved'
    | 'confirmation_rejected'
    | 'human_step_completed';
  resumedAt: string;
  resumedBy: string | null;
  sessionId: string | null;
  confirmationId: string | null;
  note: string | null;
  pendingToolCall: BrowserPendingToolCall | null;
};

export type ExecutionDecision = {
  backend: 'direct_http' | 'container';
  authPath: 'api_key' | 'subscription' | 'none';
  credentialSource:
    | 'db_secret'
    | 'env'
    | 'oauth_token'
    | 'auth_token'
    | 'host_auth'
    | 'missing';
  routeReason?: 'browser_fast_lane' | 'subscription_fallback' | 'normal' | null;
  plannerReason: string;
  providerId: string;
  modelId: string;
};

export type CarriedBrowserSession = {
  sessionId: string;
  siteKey: string;
  accountLabel: string | null;
  lastKnownState: 'active' | 'blocked' | 'takeover' | 'closed' | 'dead';
  blockedKind: BrowserBlockedKind | null;
  lastKnownUrl: string;
  lastKnownTitle: string;
  lastUpdatedAt: string;
};

export type BrowserSessionStatus = {
  sessionId: string;
  siteKey: string;
  accountLabel: string | null;
  headed: boolean;
  state: 'active' | 'blocked' | 'takeover' | 'closed' | 'dead';
  owner: 'agent' | 'user';
  blockedKind: BrowserBlockedKind | null;
  blockedMessage: string | null;
  currentUrl: string;
  currentTitle: string;
  lastUpdatedAt: string;
};

export type BrowserSetupResult = {
  status:
    | 'ok'
    | 'needs_auth'
    | 'human_step_required'
    | 'awaiting_confirmation'
    | 'error';
  siteKey: string;
  accountLabel: string | null;
  sessionId?: string;
  url: string;
  title: string;
  reusedSession: boolean;
  createdProfile: boolean;
  message: string;
  setupCommand?: string;
};

export type TalkRun = {
  id: string;
  threadId: string;
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
  browserBlock?: BrowserBlock | null;
  browserResume?: BrowserResume | null;
  carriedBrowserSessions?: CarriedBrowserSession[];
  executionDecision?: ExecutionDecision | null;
  completionStatus?: 'complete' | 'incomplete' | null;
  providerStopReason?: string | null;
  incompleteReason?: 'truncated' | 'empty' | 'unknown' | null;
};

export type TalkRunContextStateEntrySnapshot = {
  key: string;
  value: unknown;
  version: number;
  updatedAt: string;
  reason: 'state_snapshot' | 'retrieved';
};

export type TalkRunContextSourceManifestItem = {
  ref: string;
  title: string;
  sourceType: string;
  sourceUrl: string | null;
  fileName: string | null;
};

export type TalkRunContextInlineSourceSnapshot = {
  ref: string;
  text: string;
};

export type TalkRunContextRetrievedSourceSnapshot = {
  ref: string;
  title: string;
  excerpt: string;
};

export type TalkRunContextSnapshot = {
  version: 1;
  threadId: string | null;
  personaRole:
    | 'assistant'
    | 'analyst'
    | 'critic'
    | 'strategist'
    | 'devils-advocate'
    | 'synthesizer'
    | 'editor'
    | null;
  roleHint: string | null;
  goalIncluded: boolean;
  summaryIncluded: boolean;
  activeRules: string[];
  stateSnapshot: {
    totalCount: number;
    omittedCount: number;
    included: TalkRunContextStateEntrySnapshot[];
  };
  sources: {
    totalCount: number;
    manifest: TalkRunContextSourceManifestItem[];
    inline: TalkRunContextInlineSourceSnapshot[];
  };
  retrieval: {
    query: string | null;
    queryTerms: string[];
    roleTerms: string[];
    state: TalkRunContextStateEntrySnapshot[];
    sources: TalkRunContextRetrievedSourceSnapshot[];
  };
  tools: {
    contextToolNames: string[];
    connectorToolNames: string[];
  };
  history: {
    messageIds: string[];
    turnCount: number;
  };
  estimatedTokens: number;
};

export type TalkResourceBinding = {
  id: string;
  kind:
    | 'google_drive_folder'
    | 'google_drive_file'
    | 'data_connector'
    | 'saved_source'
    | 'message_attachment';
  externalId: string;
  displayName: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  createdBy: string | null;
};

export type UserGoogleAccount = {
  connected: boolean;
  email: string | null;
  displayName: string | null;
  scopes: string[];
  accessExpiresAt: string | null;
};

export type GoogleAccountAuthorizationLaunch = {
  authorizationUrl: string;
  expiresInSec: number;
};

export type GooglePickerSession = {
  oauthToken: string;
  developerKey: string;
  appId: string;
};

export type TalkAuditEntry = {
  id: string;
  runId: string;
  agentId: string | null;
  toolName: string;
  confirmationId: string | null;
  targetResourceId: string | null;
  summary: Record<string, unknown> | null;
  resultStatus: 'success' | 'failed';
  errorCategory:
    | 'auth'
    | 'permission'
    | 'rate_limit'
    | 'quota'
    | 'validation'
    | 'transient'
    | 'unavailable'
    | 'user_declined'
    | 'revoked_after_confirmation'
    | null;
  errorMessage: string | null;
  createdAt: string;
  createdBy: string | null;
};

export type TalkActionConfirmation = {
  id: string;
  talkId: string;
  runId: string;
  toolName: string;
  confirmationType: 'mutation' | 'scope_expansion';
  status:
    | 'pending'
    | 'approved_pending_execution'
    | 'approved_executed'
    | 'approved_failed'
    | 'rejected'
    | 'superseded';
  proposedArgs: Record<string, unknown> | null;
  modifiedArgs: Record<string, unknown> | null;
  preview: Record<string, unknown> | null;
  toolCallId: string | null;
  requestedBy: string;
  resolvedBy: string | null;
  reason: string | null;
  errorCategory:
    | 'auth'
    | 'permission'
    | 'rate_limit'
    | 'quota'
    | 'validation'
    | 'transient'
    | 'unavailable'
    | 'user_declined'
    | 'revoked_after_confirmation'
    | null;
  errorMessage: string | null;
  createdAt: string;
  resolvedAt: string | null;
};

export type TalkAgent = {
  id: string;
  nickname: string;
  nicknameMode: 'auto' | 'custom';
  sourceKind: 'claude_default' | 'provider';
  role:
    | 'assistant'
    | 'analyst'
    | 'critic'
    | 'strategist'
    | 'devils-advocate'
    | 'synthesizer'
    | 'editor';
  isPrimary: boolean;
  displayOrder: number;
  health: 'ready' | 'invalid' | 'unknown';
  providerId: string | null;
  modelId: string | null;
  modelDisplayName: string | null;
  // Resolved model capabilities (backend-surfaced). Used to decide whether
  // the Talk has a vision-but-not-PDF agent that benefits from rasterized
  // PDF pages.
  supportsVision: boolean;
  supportsPdfDocuments: boolean;
};

export type ProviderCredentialScope = 'user' | 'workspace';

export type ProviderVerificationStatus =
  | 'missing'
  | 'not_verified'
  | 'verifying'
  | 'verified'
  | 'invalid'
  | 'unavailable'
  | 'rate_limited';

export type AgentProviderCard = {
  id: string;
  name: string;
  providerKind:
    | 'anthropic'
    | 'openai'
    | 'gemini'
    | 'deepseek'
    | 'kimi'
    | 'nvidia'
    | 'custom';
  apiFormat: 'anthropic_messages' | 'openai_chat_completions';
  baseUrl: string;
  authScheme: 'x_api_key' | 'bearer';
  enabled: boolean;
  credentialMode: 'api_key' | 'subscription_only';
  hasCredential: boolean;
  credentialHint: string | null;
  verificationStatus: ProviderVerificationStatus;
  lastVerifiedAt: string | null;
  lastVerificationError: string | null;
  workspaceHasCredential: boolean;
  workspaceCredentialHint: string | null;
  workspaceVerificationStatus: ProviderVerificationStatus;
  workspaceLastVerifiedAt: string | null;
  workspaceLastVerificationError: string | null;
  hasPersonalSubscription: boolean;
  personalSubscriptionExpiresAt: string | null;
  hasWorkspaceSubscription: boolean;
  workspaceSubscriptionExpiresAt: string | null;
  modelSuggestions: Array<{
    modelId: string;
    displayName: string;
    contextWindowTokens: number;
    defaultMaxOutputTokens: number;
    supportsTools?: boolean;
    supportsVision?: boolean;
  }>;
  liveModelDiscovery?: {
    status: 'ok' | 'auth_error' | 'unavailable' | 'rate_limited';
    message?: string;
  };
};

export type AiAgentsPageData = {
  defaultClaudeModelId: string;
  claudeModelSuggestions: Array<{
    modelId: string;
    displayName: string;
    contextWindowTokens: number;
    defaultMaxOutputTokens: number;
    supportsTools?: boolean;
    supportsVision?: boolean;
  }>;
  additionalProviders: AgentProviderCard[];
};

export type TalkLlmProvider = {
  id: string;
  name: string;
  providerKind:
    | 'anthropic'
    | 'openai'
    | 'gemini'
    | 'deepseek'
    | 'kimi'
    | 'nvidia'
    | 'custom';
  apiFormat: 'anthropic_messages' | 'openai_chat_completions';
  baseUrl: string;
  authScheme: 'x_api_key' | 'bearer';
  enabled: boolean;
  coreCompatibility: 'none' | 'claude_sdk_proxy';
  responseStartTimeoutMs: number | null;
  streamIdleTimeoutMs: number | null;
  absoluteTimeoutMs: number | null;
  hasCredential: boolean;
  models: Array<{
    modelId: string;
    displayName: string;
    contextWindowTokens: number;
    defaultMaxOutputTokens: number;
    enabled: boolean;
    supportsTools?: boolean;
    supportsVision?: boolean;
  }>;
};

export type TalkLlmRoute = {
  id: string;
  name: string;
  enabled: boolean;
  assignedAgentCount: number;
  assignedTalkCount: number;
  steps: Array<{
    position: number;
    providerId: string;
    modelId: string;
  }>;
};

export type TalkLlmSettings = {
  defaultRouteId: string | null;
  providers: TalkLlmProvider[];
  routes: TalkLlmRoute[];
};

export type TalkLlmSettingsUpdate = {
  defaultRouteId: string;
  providers: Array<
    Omit<TalkLlmProvider, 'hasCredential'> & {
      credential?: { apiKey: string; organizationId?: string } | null;
    }
  >;
  routes: Array<Omit<TalkLlmRoute, 'assignedAgentCount' | 'assignedTalkCount'>>;
};

export type SettingsActor = {
  id: string;
  displayName: string;
};

export type ExecutorSettings = {
  configuredAliasMap: Record<string, string>;
  effectiveAliasMap: Record<string, string>;
  defaultAlias: string;
  executorAuthMode: 'subscription' | 'api_key' | 'advanced_bearer' | 'none';
  authModeSource: 'settings' | 'inferred';
  hasApiKey: boolean;
  hasOauthToken: boolean;
  hasAuthToken: boolean;
  apiKeySource: 'stored' | 'env' | null;
  oauthTokenSource: 'stored' | 'env' | null;
  authTokenSource: 'stored' | 'env' | null;
  apiKeyHint: string | null;
  oauthTokenHint: string | null;
  authTokenHint: string | null;
  activeCredentialConfigured: boolean;
  verificationStatus:
    | 'missing'
    | 'not_verified'
    | 'verifying'
    | 'verified'
    | 'invalid'
    | 'unavailable'
    | 'rate_limited';
  lastVerifiedAt: string | null;
  lastVerificationError: string | null;
  anthropicBaseUrl: string;
  isConfigured: boolean;
  configVersion: number;
  lastUpdatedAt: string | null;
  lastUpdatedBy: SettingsActor | null;
  configErrors: string[];
};

type ApiEnvelope<T> =
  | {
      ok: true;
      data: T;
    }
  | {
      ok: false;
      error: {
        code: string;
        message: string;
      };
    };

export type StartAuthPayload = {
  state: string;
  authorizationUrl: string;
  expiresInSec: number;
};

export type AuthConfigPayload = {
  devMode: boolean;
};

const AUTH_REFRESH_PATH = '/api/v1/auth/refresh';
const AUTH_CALLBACK_PATH = '/api/v1/auth/callback';
const AUTH_LOGOUT_PATH = '/api/v1/auth/logout';
let refreshInFlight: Promise<boolean> | null = null;

export async function getAuthConfig(): Promise<AuthConfigPayload> {
  return apiRequest<AuthConfigPayload>('/api/v1/auth/config');
}

type SessionMePayload = {
  user: Omit<SessionUser, 'workspaces' | 'currentWorkspaceId'>;
  workspaces?: SessionWorkspace[];
  currentWorkspaceId?: string;
};

function sessionUserFromPayload(envelope: SessionMePayload): SessionUser {
  return {
    ...envelope.user,
    ...(envelope.workspaces ? { workspaces: envelope.workspaces } : {}),
    ...(envelope.currentWorkspaceId
      ? { currentWorkspaceId: envelope.currentWorkspaceId }
      : {}),
  };
}

export async function getSessionMe(): Promise<SessionUser> {
  try {
    return sessionUserFromPayload(
      await apiRequest<SessionMePayload>('/api/v1/session/me'),
    );
  } catch (err) {
    // The active-workspace marker may point at a workspace this session can no
    // longer access (e.g. after sign-out on a shared device, or losing
    // membership). Drop it and retry so the backend falls back to the default
    // workspace instead of locking the user out.
    if (err instanceof ApiError && err.code === 'workspace_forbidden') {
      rememberActiveWorkspace(null);
      return sessionUserFromPayload(
        await apiRequest<SessionMePayload>('/api/v1/session/me'),
      );
    }
    throw err;
  }
}

export async function updateSessionMe(input: {
  workspaceId?: string | null;
  displayName?: string;
}): Promise<SessionUser> {
  const { workspaceId, ...body } = input;
  const envelope = await apiMutationRequest<SessionMePayload>(
    withWorkspaceQuery('/api/v1/session/me', workspaceId),
    {
      method: 'PATCH',
      body: JSON.stringify(body),
    },
  );
  return sessionUserFromPayload(envelope);
}

export async function switchWorkspace(
  workspaceId: string,
): Promise<{ currentWorkspaceId: string }> {
  return apiMutationRequest<{ currentWorkspaceId: string }>(
    '/api/v1/workspaces/switch',
    {
      method: 'POST',
      includeJson: true,
      body: JSON.stringify({ workspaceId }),
    },
  );
}

export async function startGoogleAuth(input?: {
  returnTo?: string;
}): Promise<StartAuthPayload> {
  if (input?.returnTo) {
    return apiRequest<StartAuthPayload>('/api/v1/auth/google/start', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({ returnTo: input.returnTo }),
    });
  }

  return apiRequest<StartAuthPayload>('/api/v1/auth/google/start', {
    method: 'POST',
  });
}

export async function completeDevCallback(callbackUrl: string): Promise<void> {
  const response = await fetch(callbackUrl, {
    method: 'GET',
    credentials: 'include',
    headers: {
      accept: 'application/json',
    },
  });
  if (response.status === 401) {
    throw new UnauthorizedError();
  }
  if (!response.ok) {
    throw new Error(`Dev callback failed with status ${response.status}`);
  }
}

export async function listTalks(): Promise<Talk[]> {
  const envelope = await apiRequest<{
    talks: Talk[];
    page: { limit: number; offset: number; count: number };
  }>('/api/v1/talks');
  return envelope.talks;
}

/** Archived talks only — the `include_archived` list filtered to `status==='archived'`. */
export async function listArchivedTalks(): Promise<Talk[]> {
  const envelope = await apiRequest<{
    talks: Talk[];
    page: { limit: number; offset: number; count: number };
  }>('/api/v1/talks?include_archived=true');
  return envelope.talks.filter((talk) => talk.status === 'archived');
}

/** Restore an archived talk (clears `archived_at`). */
export async function unarchiveTalk(talkId: string): Promise<void> {
  await apiMutationRequest<{ restored: true }>(
    `/api/v1/talks/${encodeURIComponent(talkId)}/unarchive`,
    { method: 'POST' },
  );
}

export async function createTalk(title: string): Promise<Talk> {
  const envelope = await apiMutationRequest<{ talk: Talk }>('/api/v1/talks', {
    method: 'POST',
    includeJson: true,
    body: JSON.stringify({ title }),
  });
  return envelope.talk;
}

export async function getTalkSidebar(): Promise<TalkSidebarTree> {
  return apiRequest<TalkSidebarTree>('/api/v1/talks/sidebar');
}

export async function createTalkFolder(
  title?: string,
): Promise<TalkSidebarFolder> {
  const envelope = await apiMutationRequest<{
    folder: {
      id: string;
      title: string;
      sortOrder: number;
      talks: TalkSidebarTalk[];
    };
  }>('/api/v1/talk-folders', {
    method: 'POST',
    includeJson: true,
    body: JSON.stringify({ title }),
  });
  return { ...envelope.folder, type: 'folder' };
}

export async function patchTalkFolder(input: {
  folderId: string;
  title: string;
}): Promise<TalkSidebarFolder> {
  const envelope = await apiMutationRequest<{
    folder: {
      id: string;
      title: string;
      sortOrder: number;
      talks: TalkSidebarTalk[];
    };
  }>(`/api/v1/talk-folders/${encodeURIComponent(input.folderId)}`, {
    method: 'PATCH',
    includeJson: true,
    body: JSON.stringify({ title: input.title }),
  });
  return { ...envelope.folder, type: 'folder' };
}

export async function deleteTalkFolder(folderId: string): Promise<void> {
  await apiMutationRequest<{ deleted: true }>(
    `/api/v1/talk-folders/${encodeURIComponent(folderId)}`,
    {
      method: 'DELETE',
    },
  );
}

export async function patchTalkMetadata(input: {
  talkId: string;
  title?: string;
  folderId?: string | null;
  orchestrationMode?: 'ordered' | 'panel';
}): Promise<Talk> {
  const envelope = await apiMutationRequest<{ talk: Talk }>(
    `/api/v1/talks/${encodeURIComponent(input.talkId)}`,
    {
      method: 'PATCH',
      includeJson: true,
      body: JSON.stringify({
        title: input.title,
        folderId: input.folderId,
        orchestrationMode: input.orchestrationMode,
      }),
    },
  );
  return envelope.talk;
}

export async function deleteTalk(talkId: string): Promise<void> {
  await apiMutationRequest<{ deleted: true }>(
    `/api/v1/talks/${encodeURIComponent(talkId)}`,
    {
      method: 'DELETE',
    },
  );
}

export async function reorderTalkSidebar(input: {
  itemType: 'talk' | 'folder';
  itemId: string;
  destinationFolderId: string | null;
  destinationIndex: number;
}): Promise<void> {
  await apiMutationRequest<{ reordered: true }>(
    '/api/v1/talks/sidebar/reorder',
    {
      method: 'POST',
      includeJson: true,
      body: JSON.stringify(input),
    },
  );
}

export async function getTalk(talkId: string): Promise<Talk> {
  const envelope = await apiRequest<{ talk: Talk }>(
    `/api/v1/talks/${encodeURIComponent(talkId)}`,
  );
  return envelope.talk;
}

export type TalkSnapshotThread = {
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
};

export type TalkSnapshotTalk = {
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
  accessRole: Talk['accessRole'];
};

export type TalkSnapshotAgent = {
  assignmentId: string;
  agentId: string;
  agentName: string;
  nickname: string;
  personaRole: string | null;
  isPrimary: boolean;
  sortOrder: number;
};

export type TalkSnapshotRun = {
  id: string;
  threadId: string;
  status: TalkRun['status'];
  responseGroupId: string | null;
  sequenceIndex: number | null;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  triggerMessageId: string | null;
  targetAgentId: string | null;
  executorAlias: string | null;
  executorModel: string | null;
};

export type TalkSnapshot = {
  talk: TalkSnapshotTalk;
  threads: TalkSnapshotThread[];
  activeThreadId: string;
  messages: TalkMessage[];
  hasOlderMessages: boolean;
  content: Content | null;
  pendingEdits: ContentEditSummary[];
  runs: TalkSnapshotRun[];
  agents: TalkSnapshotAgent[];
  snapshotVersion: number;
};

export async function getTalkSnapshot(input: {
  talkId: string;
  threadId?: string | null;
}): Promise<TalkSnapshot> {
  const params = new URLSearchParams();
  if (input.threadId) {
    params.set('threadId', input.threadId);
  }
  return apiRequest<TalkSnapshot>(
    `/api/v1/talks/${encodeURIComponent(input.talkId)}/snapshot${
      params.size > 0 ? `?${params.toString()}` : ''
    }`,
  );
}

export type ContentEditSummary = {
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
};

export async function getTalkContent(talkId: string): Promise<{
  content: Content | null;
  pendingEdits: ContentEditSummary[];
}> {
  return apiRequest<{
    content: Content | null;
    pendingEdits: ContentEditSummary[];
  }>(`/api/v1/talks/${encodeURIComponent(talkId)}/content`);
}

export async function getThreadContent(threadId: string): Promise<{
  content: Content | null;
  pendingEdits: ContentEditSummary[];
}> {
  return apiRequest<{
    content: Content | null;
    pendingEdits: ContentEditSummary[];
  }>(`/api/v1/threads/${encodeURIComponent(threadId)}/content`);
}

export async function createTalkContent(input: {
  talkId: string;
  title: string;
  format?: ContentFormat;
}): Promise<Content> {
  const body: Record<string, unknown> = { title: input.title };
  if (input.format) body.format = input.format;
  const envelope = await apiMutationRequest<{ content: Content }>(
    `/api/v1/talks/${encodeURIComponent(input.talkId)}/content`,
    {
      method: 'POST',
      includeJson: true,
      body: JSON.stringify(body),
    },
  );
  return envelope.content;
}

export async function createThreadContent(input: {
  threadId: string;
  title: string;
  format?: ContentFormat;
}): Promise<Content> {
  const body: Record<string, unknown> = { title: input.title };
  if (input.format) body.format = input.format;
  const envelope = await apiMutationRequest<{ content: Content }>(
    `/api/v1/threads/${encodeURIComponent(input.threadId)}/content`,
    {
      method: 'POST',
      includeJson: true,
      body: JSON.stringify(body),
    },
  );
  return envelope.content;
}

export async function patchContent(input: {
  contentId: string;
  expectedVersion: number;
  bodyMarkdown?: string;
  bodyHtml?: string;
  title?: string;
  acceptPendingEditIds?: string[];
}): Promise<{ content: Content; acceptedPendingEditIds?: string[] }> {
  const body: Record<string, unknown> = {
    expectedVersion: input.expectedVersion,
  };
  if (typeof input.bodyMarkdown === 'string') {
    body.bodyMarkdown = input.bodyMarkdown;
  }
  if (typeof input.bodyHtml === 'string') {
    body.bodyHtml = input.bodyHtml;
  }
  if (typeof input.title === 'string') {
    body.title = input.title;
  }
  if (Array.isArray(input.acceptPendingEditIds)) {
    body.acceptPendingEditIds = input.acceptPendingEditIds;
  }
  return apiMutationRequest<{
    content: Content;
    acceptedPendingEditIds?: string[];
  }>(`/api/v1/contents/${encodeURIComponent(input.contentId)}`, {
    method: 'PATCH',
    includeJson: true,
    body: JSON.stringify(body),
  });
}

export async function acceptContentEdit(input: {
  contentId: string;
  editId: string;
  expectedContentVersion: number;
}): Promise<{ content: Content; editId: string; runId: string }> {
  return apiMutationRequest<{
    content: Content;
    editId: string;
    runId: string;
  }>(
    `/api/v1/contents/${encodeURIComponent(input.contentId)}/edits/${encodeURIComponent(input.editId)}/accept`,
    {
      method: 'POST',
      includeJson: true,
      body: JSON.stringify({
        expectedContentVersion: input.expectedContentVersion,
      }),
    },
  );
}

export async function rejectContentEdit(input: {
  contentId: string;
  editId: string;
}): Promise<{ editId: string; runId: string }> {
  return apiMutationRequest<{ editId: string; runId: string }>(
    `/api/v1/contents/${encodeURIComponent(input.contentId)}/edits/${encodeURIComponent(input.editId)}/reject`,
    {
      method: 'POST',
      includeJson: true,
      body: '{}',
    },
  );
}

export async function acceptContentEditRun(input: {
  contentId: string;
  runId: string;
  expectedContentVersion: number;
}): Promise<{ content: Content; runId: string; editIds: string[] }> {
  return apiMutationRequest<{
    content: Content;
    runId: string;
    editIds: string[];
  }>(
    `/api/v1/contents/${encodeURIComponent(input.contentId)}/runs/${encodeURIComponent(input.runId)}/accept`,
    {
      method: 'POST',
      includeJson: true,
      body: JSON.stringify({
        expectedContentVersion: input.expectedContentVersion,
      }),
    },
  );
}

export async function rejectContentEditRun(input: {
  contentId: string;
  runId: string;
}): Promise<{ runId: string; editIds: string[] }> {
  return apiMutationRequest<{ runId: string; editIds: string[] }>(
    `/api/v1/contents/${encodeURIComponent(input.contentId)}/runs/${encodeURIComponent(input.runId)}/reject`,
    {
      method: 'POST',
      includeJson: true,
      body: '{}',
    },
  );
}

export async function listTalkThreads(talkId: string): Promise<TalkThread[]> {
  const envelope = await apiRequest<{
    threads: Array<{
      id: string;
      talk_id: string;
      title: string | null;
      is_default: number;
      is_pinned: number;
      created_at: string;
      updated_at: string;
      message_count: number;
      last_message_at: string | null;
    }>;
  }>(`/api/v1/talks/${encodeURIComponent(talkId)}/threads`);
  return envelope.threads.map((thread) => ({
    id: thread.id,
    talkId: thread.talk_id,
    title: thread.title,
    isDefault: thread.is_default === 1,
    isPinned: thread.is_pinned === 1,
    createdAt: thread.created_at,
    updatedAt: thread.updated_at,
    messageCount: thread.message_count,
    lastMessageAt: thread.last_message_at,
  }));
}

export async function createTalkThread(input: {
  talkId: string;
  title?: string;
}): Promise<TalkThread> {
  const envelope = await apiMutationRequest<{
    thread: {
      id: string;
      talk_id: string;
      title: string | null;
      is_default: number;
      is_pinned: number;
      created_at: string;
      updated_at: string;
      message_count?: number;
      last_message_at?: string | null;
    };
  }>(`/api/v1/talks/${encodeURIComponent(input.talkId)}/threads`, {
    method: 'POST',
    includeJson: true,
    body: JSON.stringify({ title: input.title ?? null }),
  });
  if (!envelope.thread || typeof envelope.thread.id !== 'string') {
    throw new Error('Invalid thread response');
  }
  return {
    id: envelope.thread.id,
    talkId: envelope.thread.talk_id,
    title: envelope.thread.title,
    isDefault: envelope.thread.is_default === 1,
    isPinned: envelope.thread.is_pinned === 1,
    createdAt: envelope.thread.created_at,
    updatedAt: envelope.thread.updated_at,
    messageCount: envelope.thread.message_count ?? 0,
    lastMessageAt: envelope.thread.last_message_at ?? null,
  };
}

export async function updateTalkThread(input: {
  talkId: string;
  threadId: string;
  title?: string;
  pinned?: boolean;
}): Promise<TalkThreadUpdate> {
  const envelope = await apiMutationRequest<{
    id: string;
    talk_id: string;
    title: string | null;
    is_default: number;
    is_pinned: number;
    created_at: string;
    updated_at: string;
  }>(
    `/api/v1/talks/${encodeURIComponent(input.talkId)}/threads/${encodeURIComponent(input.threadId)}`,
    {
      method: 'PATCH',
      includeJson: true,
      body: JSON.stringify({
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.pinned !== undefined ? { pinned: input.pinned } : {}),
      }),
    },
  );
  return {
    id: envelope.id,
    talkId: envelope.talk_id,
    title: envelope.title,
    isDefault: envelope.is_default === 1,
    isPinned: envelope.is_pinned === 1,
    createdAt: envelope.created_at,
    updatedAt: envelope.updated_at,
  };
}

export async function deleteTalkThread(input: {
  talkId: string;
  threadId: string;
}): Promise<void> {
  await apiMutationRequest<{ deleted: true }>(
    `/api/v1/talks/${encodeURIComponent(input.talkId)}/threads/${encodeURIComponent(input.threadId)}`,
    {
      method: 'DELETE',
    },
  );
}

export async function listTalkMessages(
  talkId: string,
  options?: {
    threadId?: string | null;
    before?: string | null;
    limit?: number;
  },
): Promise<TalkMessage[]> {
  const params = new URLSearchParams();
  if (options?.threadId) {
    params.set('threadId', options.threadId);
  }
  if (options?.before) {
    params.set('before', options.before);
  }
  if (typeof options?.limit === 'number') {
    params.set('limit', String(options.limit));
  }
  const envelope = await apiRequest<{
    talkId: string;
    messages: TalkMessage[];
    page: { limit: number; count: number; beforeCreatedAt: string | null };
  }>(
    `/api/v1/talks/${encodeURIComponent(talkId)}/messages${
      params.size > 0 ? `?${params.toString()}` : ''
    }`,
  );
  return envelope.messages;
}

export async function searchTalkMessages(input: {
  talkId: string;
  query: string;
  limit?: number;
}): Promise<TalkMessageSearchResult[]> {
  const params = new URLSearchParams({ q: input.query });
  if (typeof input.limit === 'number') {
    params.set('limit', String(input.limit));
  }
  const envelope = await apiRequest<{
    talkId: string;
    query: string;
    results: TalkMessageSearchResult[];
  }>(
    `/api/v1/talks/${encodeURIComponent(input.talkId)}/messages/search?${params.toString()}`,
  );
  return envelope.results;
}

export async function deleteTalkMessages(input: {
  talkId: string;
  messageIds: string[];
  threadId: string;
}): Promise<{
  talkId: string;
  deletedCount: number;
  deletedMessageIds: string[];
}> {
  return apiMutationRequest<{
    talkId: string;
    deletedCount: number;
    deletedMessageIds: string[];
  }>(`/api/v1/talks/${encodeURIComponent(input.talkId)}/messages/delete`, {
    method: 'POST',
    includeJson: true,
    body: JSON.stringify({
      messageIds: input.messageIds,
      threadId: input.threadId,
    }),
  });
}

export async function getTalkAgents(talkId: string): Promise<TalkAgent[]> {
  const envelope = await apiRequest<{
    talkId: string;
    agents: TalkAgent[];
  }>(`/api/v1/talks/${encodeURIComponent(talkId)}/agents`);
  return envelope.agents;
}

export async function getTalkRuns(talkId: string): Promise<TalkRun[]> {
  const envelope = await apiRequest<{
    talkId: string;
    runs: TalkRun[];
  }>(`/api/v1/talks/${encodeURIComponent(talkId)}/runs`);
  return envelope.runs;
}

export async function getTalkRunContext(input: {
  talkId: string;
  runId: string;
}): Promise<TalkRunContextSnapshot | null> {
  const envelope = await apiRequest<{
    talkId: string;
    runId: string;
    contextSnapshot: TalkRunContextSnapshot | null;
  }>(
    `/api/v1/talks/${encodeURIComponent(input.talkId)}/runs/${encodeURIComponent(input.runId)}/context`,
  );
  return envelope.contextSnapshot;
}

export async function getTalkResources(input: {
  talkId: string;
}): Promise<{ talkId: string; bindings: TalkResourceBinding[] }> {
  return apiRequest<{ talkId: string; bindings: TalkResourceBinding[] }>(
    `/api/v1/talks/${encodeURIComponent(input.talkId)}/resources`,
  );
}

export async function createTalkGoogleDriveResource(input: {
  talkId: string;
  kind: 'google_drive_folder' | 'google_drive_file';
  externalId: string;
  displayName: string;
  metadata?: Record<string, unknown> | null;
}): Promise<TalkResourceBinding> {
  const envelope = await apiMutationRequest<{ binding: TalkResourceBinding }>(
    `/api/v1/talks/${encodeURIComponent(input.talkId)}/resources`,
    {
      method: 'POST',
      includeJson: true,
      body: JSON.stringify({
        kind: input.kind,
        externalId: input.externalId,
        displayName: input.displayName,
        metadata: input.metadata ?? null,
      }),
    },
  );
  return envelope.binding;
}

export async function deleteTalkResource(input: {
  talkId: string;
  resourceId: string;
}): Promise<void> {
  await apiMutationRequest<{ deleted: true }>(
    `/api/v1/talks/${encodeURIComponent(input.talkId)}/resources/${encodeURIComponent(input.resourceId)}`,
    {
      method: 'DELETE',
    },
  );
}

type WorkspaceScopedRequest = {
  workspaceId?: string | null;
};

type RequiredWorkspaceScopedRequest = {
  workspaceId: string;
};

type GooglePickerSessionRequest =
  | { talkId: string; workspaceId?: string | null }
  | { workspaceId: string; talkId?: string | null };

function withWorkspaceQuery(path: string, workspaceId?: string | null): string {
  if (!workspaceId) return path;
  const separator = path.includes('?') ? '&' : '?';
  return `${path}${separator}workspaceId=${encodeURIComponent(workspaceId)}`;
}

export async function getUserGoogleAccount(
  input: RequiredWorkspaceScopedRequest,
): Promise<UserGoogleAccount> {
  const envelope = await apiRequest<{ googleAccount: UserGoogleAccount }>(
    withWorkspaceQuery('/api/v1/me/google-account', input.workspaceId),
  );
  return envelope.googleAccount;
}

export async function connectUserGoogleAccount(input: {
  workspaceId: string;
  returnTo?: string;
  scopes?: string[];
}): Promise<GoogleAccountAuthorizationLaunch> {
  const envelope = await apiMutationRequest<GoogleAccountAuthorizationLaunch>(
    withWorkspaceQuery('/api/v1/me/google-account/connect', input.workspaceId),
    {
      method: 'POST',
      includeJson: true,
      body: JSON.stringify({
        returnTo: input?.returnTo,
        scopes: input?.scopes,
      }),
    },
  );
  return envelope;
}

export async function expandUserGoogleScopes(input: {
  workspaceId: string;
  scopes: string[];
  returnTo?: string;
}): Promise<GoogleAccountAuthorizationLaunch> {
  const envelope = await apiMutationRequest<GoogleAccountAuthorizationLaunch>(
    withWorkspaceQuery(
      '/api/v1/me/google-account/expand-scopes',
      input.workspaceId,
    ),
    {
      method: 'POST',
      includeJson: true,
      body: JSON.stringify({
        scopes: input.scopes,
        returnTo: input.returnTo,
      }),
    },
  );
  return envelope;
}

export async function getGooglePickerSession(
  input: GooglePickerSessionRequest,
): Promise<GooglePickerSession>;
export async function getGooglePickerSession(
  input: GooglePickerSessionRequest,
): Promise<GooglePickerSession> {
  const params = new URLSearchParams();
  if (input.talkId) params.set('talkId', input.talkId);
  if (input.workspaceId) params.set('workspaceId', input.workspaceId);
  const query = params.size > 0 ? `?${params.toString()}` : '';
  return apiRequest<GooglePickerSession>(
    `/api/v1/me/google-account/picker-token${query}`,
  );
}

export async function disconnectUserGoogleAccount(
  input: RequiredWorkspaceScopedRequest,
): Promise<{
  disconnected: boolean;
}> {
  return apiMutationRequest<{ disconnected: boolean }>(
    withWorkspaceQuery(
      '/api/v1/me/google-account/disconnect',
      input.workspaceId,
    ),
    {
      method: 'POST',
      includeJson: true,
      body: JSON.stringify({}),
    },
  );
}

export async function getTalkAudit(input: {
  talkId: string;
  limit?: number;
}): Promise<{ talkId: string; entries: TalkAuditEntry[] }> {
  const query = input.limit
    ? `?limit=${encodeURIComponent(String(input.limit))}`
    : '';
  return apiRequest<{ talkId: string; entries: TalkAuditEntry[] }>(
    `/api/v1/talks/${encodeURIComponent(input.talkId)}/audit${query}`,
  );
}

export async function approveTalkActionConfirmation(input: {
  talkId: string;
  runId: string;
  confirmationId: string;
  modifiedArgs?: Record<string, unknown> | null;
}): Promise<TalkActionConfirmation> {
  const envelope = await apiMutationRequest<{
    confirmation: TalkActionConfirmation;
  }>(
    `/api/v1/talks/${encodeURIComponent(input.talkId)}/runs/${encodeURIComponent(input.runId)}/confirmations/${encodeURIComponent(input.confirmationId)}/approve`,
    {
      method: 'POST',
      includeJson: true,
      body: JSON.stringify({ modifiedArgs: input.modifiedArgs ?? null }),
    },
  );
  return envelope.confirmation;
}

export async function rejectTalkActionConfirmation(input: {
  talkId: string;
  runId: string;
  confirmationId: string;
  reason?: string | null;
}): Promise<TalkActionConfirmation> {
  const envelope = await apiMutationRequest<{
    confirmation: TalkActionConfirmation;
  }>(
    `/api/v1/talks/${encodeURIComponent(input.talkId)}/runs/${encodeURIComponent(input.runId)}/confirmations/${encodeURIComponent(input.confirmationId)}/reject`,
    {
      method: 'POST',
      includeJson: true,
      body: JSON.stringify({ reason: input.reason ?? null }),
    },
  );
  return envelope.confirmation;
}

export async function startBrowserSetupSession(input: {
  siteKey: string;
  accountLabel?: string | null;
  url?: string | null;
}): Promise<BrowserSetupResult> {
  return apiMutationRequest<BrowserSetupResult>('/api/v1/browser/setup', {
    method: 'POST',
    includeJson: true,
    body: JSON.stringify({
      siteKey: input.siteKey,
      accountLabel: input.accountLabel ?? null,
      url: input.url ?? null,
    }),
  });
}

export async function startBrowserTakeover(
  sessionId: string,
): Promise<BrowserSessionStatus> {
  return apiMutationRequest<BrowserSessionStatus>(
    `/api/v1/browser/sessions/${encodeURIComponent(sessionId)}/takeover`,
    {
      method: 'POST',
      includeJson: true,
      body: '{}',
    },
  );
}

export async function getBrowserSessionStatus(
  sessionId: string,
): Promise<BrowserSessionStatus> {
  return apiRequest<BrowserSessionStatus>(
    `/api/v1/browser/sessions/${encodeURIComponent(sessionId)}`,
  );
}

export async function resumeBrowserSession(
  sessionId: string,
): Promise<BrowserSessionStatus> {
  return apiMutationRequest<BrowserSessionStatus>(
    `/api/v1/browser/sessions/${encodeURIComponent(sessionId)}/resume`,
    {
      method: 'POST',
      includeJson: true,
      body: '{}',
    },
  );
}

export async function resumeBrowserBlockedRun(input: {
  runId: string;
  note?: string | null;
}): Promise<{
  runId: string;
  resumed: boolean;
  browserResume: BrowserResume;
  queueState: 'queued' | 'deferred' | null;
}> {
  return apiMutationRequest<{
    runId: string;
    resumed: boolean;
    browserResume: BrowserResume;
    queueState: 'queued' | 'deferred' | null;
  }>(`/api/v1/browser/runs/${encodeURIComponent(input.runId)}/resume`, {
    method: 'POST',
    includeJson: true,
    body: JSON.stringify({ note: input.note ?? null }),
  });
}

export async function cancelConflictingBrowserRun(input: {
  runId: string;
}): Promise<{
  runId: string;
  conflictingRunId: string;
  queuedCurrentRun: boolean;
  currentRunStatus: string | null;
}> {
  return apiMutationRequest<{
    runId: string;
    conflictingRunId: string;
    queuedCurrentRun: boolean;
    currentRunStatus: string | null;
  }>(
    `/api/v1/browser/runs/${encodeURIComponent(input.runId)}/cancel-conflict`,
    {
      method: 'POST',
      includeJson: true,
      body: '{}',
    },
  );
}

export async function approveBrowserConfirmation(input: {
  confirmationId: string;
  note?: string | null;
}): Promise<{
  confirmationId: string;
  runId: string;
  approved: boolean;
  browserResume: BrowserResume;
  queueState: 'queued' | 'deferred' | null;
}> {
  return apiMutationRequest<{
    confirmationId: string;
    runId: string;
    approved: boolean;
    browserResume: BrowserResume;
    queueState: 'queued' | 'deferred' | null;
  }>(
    `/api/v1/browser/confirmations/${encodeURIComponent(input.confirmationId)}/approve`,
    {
      method: 'POST',
      includeJson: true,
      body: JSON.stringify({ note: input.note ?? null }),
    },
  );
}

export async function rejectBrowserConfirmation(input: {
  confirmationId: string;
  note?: string | null;
}): Promise<{
  confirmationId: string;
  runId: string;
  rejected: boolean;
}> {
  return apiMutationRequest<{
    confirmationId: string;
    runId: string;
    rejected: boolean;
  }>(
    `/api/v1/browser/confirmations/${encodeURIComponent(input.confirmationId)}/reject`,
    {
      method: 'POST',
      includeJson: true,
      body: JSON.stringify({ note: input.note ?? null }),
    },
  );
}

export async function updateTalkAgents(input: {
  talkId: string;
  agents: TalkAgent[];
}): Promise<TalkAgent[]> {
  const envelope = await apiMutationRequest<{
    talkId: string;
    agents: TalkAgent[];
  }>(`/api/v1/talks/${encodeURIComponent(input.talkId)}/agents`, {
    method: 'PUT',
    includeJson: true,
    body: JSON.stringify({ agents: input.agents }),
  });
  return envelope.agents;
}

// Talk-scoped tool toggles (migration 0031).
export interface TalkToolsState {
  talkId: string;
  active: Record<string, boolean>;
  available: string[];
}

export async function getTalkTools(talkId: string): Promise<TalkToolsState> {
  return apiRequest<TalkToolsState>(
    `/api/v1/talks/${encodeURIComponent(talkId)}/tools`,
  );
}

export async function updateTalkTool(input: {
  talkId: string;
  family: string;
  enabled: boolean;
}): Promise<TalkToolsState> {
  return apiMutationRequest<TalkToolsState>(
    `/api/v1/talks/${encodeURIComponent(input.talkId)}/tools`,
    {
      method: 'PATCH',
      includeJson: true,
      body: JSON.stringify({
        family: input.family,
        enabled: input.enabled,
      }),
    },
  );
}

export async function getAiAgents(input?: {
  workspaceId?: string | null;
}): Promise<AiAgentsPageData> {
  return apiRequest<AiAgentsPageData>(
    withWorkspaceQuery('/api/v1/agents', input?.workspaceId),
  );
}

// ---------------------------------------------------------------------------
// Web Search Providers (per-user keys + active picker)
// ---------------------------------------------------------------------------

export type WebSearchProviderId =
  | 'web_search.tavily'
  | 'web_search.brave'
  | 'web_search.firecrawl'
  | 'web_search.exa';

export interface WebSearchProviderCard {
  id: WebSearchProviderId;
  name: string;
  baseUrl: string;
  enabled: boolean;
  hasCredential: boolean;
  credentialHint: string | null;
  isActive: boolean;
}

export interface WebSearchPageData {
  providers: WebSearchProviderCard[];
  activeProviderId: WebSearchProviderId | null;
}

export async function getWebSearchProviders(): Promise<WebSearchPageData> {
  return apiRequest<WebSearchPageData>('/api/v1/web-search/providers');
}

export async function setWebSearchCredential(
  providerId: WebSearchProviderId,
  apiKey: string,
): Promise<void> {
  await apiMutationRequest<{ saved: true }>(
    `/api/v1/web-search/providers/${encodeURIComponent(providerId)}`,
    {
      method: 'PUT',
      body: JSON.stringify({ apiKey }),
      includeJson: true,
    },
  );
}

export async function clearWebSearchCredential(
  providerId: WebSearchProviderId,
): Promise<void> {
  await apiMutationRequest<{ deleted: true }>(
    `/api/v1/web-search/providers/${encodeURIComponent(providerId)}`,
    { method: 'DELETE' },
  );
}

export async function setActiveWebSearchProvider(
  providerId: WebSearchProviderId | null,
): Promise<void> {
  await apiMutationRequest<{ activeProviderId: WebSearchProviderId | null }>(
    '/api/v1/web-search/active',
    {
      method: 'PUT',
      body: JSON.stringify({ providerId }),
      includeJson: true,
    },
  );
}

// ---------------------------------------------------------------------------
// Registered Agents
// ---------------------------------------------------------------------------

export type RegisteredAgentCredentialMode = 'api_key' | 'subscription';

export type RegisteredAgent = {
  id: string;
  name: string;
  providerId: string;
  modelId: string;
  personaRole: string | null;
  systemPrompt: string | null;
  description: string | null;
  enabled: boolean;
  // null = auto (resolver walks precedence). Non-null pins the agent
  // to a specific credential mode for this provider.
  credentialMode: RegisteredAgentCredentialMode | null;
  createdAt: string;
  updatedAt: string;
  executionPreview: {
    surface: 'main';
    backend: 'direct_http' | 'container' | null;
    authPath: 'api_key' | 'subscription' | null;
    selectedMode: 'api' | 'subscription' | null;
    transport: 'direct' | 'subscription' | null;
    reasonCode: string | null;
    routeReason:
      | 'normal'
      | 'subscription_fallback'
      | 'host_only'
      | 'direct_with_promotion'
      | 'no_valid_path';
    ready: boolean;
    message: string;
  };
  // Backend ground truth from resolveModelCapabilities. Used by the
  // composer's image-attachment guard for the Main slot, where the
  // TalkAgent row stores modelId=null.
  supportsVision: boolean;
  // Model-lifecycle trail (backend PR #487 + run-time net). When
  // modelAutoUpgradedFrom is set, this agent was auto-moved off a RETIRED
  // model — the card shows a badge until dismissed. modelUpdateAvailable is a
  // non-mutating "newer same-family model exists" suggestion (opt-in update,
  // never auto-applied).
  modelAutoUpgradedFrom: string | null;
  modelAutoUpgradedAt: string | null;
  modelUpdateAvailable: { modelId: string; displayName: string | null } | null;
};

export async function listRegisteredAgents(
  input?: WorkspaceScopedRequest,
): Promise<RegisteredAgent[]> {
  return apiRequest<RegisteredAgent[]>(
    withWorkspaceQuery('/api/v1/registered-agents', input?.workspaceId),
  );
}

export async function getRegisteredAgent(
  agentId: string,
  input?: WorkspaceScopedRequest,
): Promise<RegisteredAgent> {
  return apiRequest<RegisteredAgent>(
    withWorkspaceQuery(
      `/api/v1/registered-agents/${encodeURIComponent(agentId)}`,
      input?.workspaceId,
    ),
  );
}

export async function getMainRegisteredAgent(
  input?: WorkspaceScopedRequest,
): Promise<RegisteredAgent> {
  return apiRequest<RegisteredAgent>(
    withWorkspaceQuery('/api/v1/registered-agents/main', input?.workspaceId),
  );
}

export async function updateMainRegisteredAgent(
  agentId: string,
  input?: WorkspaceScopedRequest,
): Promise<RegisteredAgent> {
  return apiMutationRequest<RegisteredAgent>(
    withWorkspaceQuery('/api/v1/registered-agents/main', input?.workspaceId),
    {
      method: 'PUT',
      includeJson: true,
      body: JSON.stringify({ agentId }),
    },
  );
}

export async function createRegisteredAgent(input: {
  workspaceId?: string | null;
  name: string;
  providerId: string;
  modelId: string;
  personaRole?: string;
  systemPrompt?: string;
  description?: string;
  credentialMode?: RegisteredAgentCredentialMode | null;
}): Promise<RegisteredAgent> {
  const { workspaceId, ...body } = input;
  return apiMutationRequest<RegisteredAgent>(
    withWorkspaceQuery('/api/v1/registered-agents', workspaceId),
    {
      method: 'POST',
      includeJson: true,
      body: JSON.stringify(body),
    },
  );
}

export async function updateRegisteredAgent(input: {
  workspaceId?: string | null;
  agentId: string;
  name?: string;
  providerId?: string;
  modelId?: string;
  personaRole?: string | null;
  systemPrompt?: string | null;
  description?: string | null;
  enabled?: boolean;
  credentialMode?: RegisteredAgentCredentialMode | null;
}): Promise<RegisteredAgent> {
  const { agentId, workspaceId, ...body } = input;
  return apiMutationRequest<RegisteredAgent>(
    withWorkspaceQuery(
      `/api/v1/registered-agents/${encodeURIComponent(agentId)}`,
      workspaceId,
    ),
    {
      method: 'PUT',
      includeJson: true,
      body: JSON.stringify(body),
    },
  );
}

export async function deleteRegisteredAgent(
  agentId: string,
  input?: WorkspaceScopedRequest,
): Promise<void> {
  await apiMutationRequest<{ deleted: true }>(
    withWorkspaceQuery(
      `/api/v1/registered-agents/${encodeURIComponent(agentId)}`,
      input?.workspaceId,
    ),
    {
      method: 'DELETE',
    },
  );
}

/**
 * Dismiss the "model retired — auto-upgraded" badge for an agent. Clears the
 * persisted trail; the agent's already-upgraded model is untouched. Returns
 * the refreshed snapshot.
 */
export async function dismissAgentModelUpgrade(
  agentId: string,
  input?: WorkspaceScopedRequest,
): Promise<RegisteredAgent> {
  return apiMutationRequest<RegisteredAgent>(
    withWorkspaceQuery(
      `/api/v1/registered-agents/${encodeURIComponent(agentId)}/dismiss-model-upgrade`,
      input?.workspaceId,
    ),
    {
      method: 'POST',
    },
  );
}

// ---------------------------------------------------------------------------
// Context tab API functions
// ---------------------------------------------------------------------------

export async function getTalkContext(talkId: string): Promise<TalkContext> {
  return apiRequest<TalkContext>(
    `/api/v1/talks/${encodeURIComponent(talkId)}/context`,
  );
}

export async function setTalkGoal(input: {
  talkId: string;
  goalText: string;
}): Promise<{ goal: ContextGoal | null }> {
  return apiMutationRequest<{ goal: ContextGoal | null }>(
    `/api/v1/talks/${encodeURIComponent(input.talkId)}/context/goal`,
    {
      method: 'PUT',
      includeJson: true,
      body: JSON.stringify({ goalText: input.goalText }),
    },
  );
}

export async function createTalkContextRule(input: {
  talkId: string;
  ruleText: string;
}): Promise<ContextRule> {
  const envelope = await apiMutationRequest<{ rule: ContextRule }>(
    `/api/v1/talks/${encodeURIComponent(input.talkId)}/context/rules`,
    {
      method: 'POST',
      includeJson: true,
      body: JSON.stringify({ ruleText: input.ruleText }),
    },
  );
  return envelope.rule;
}

export async function patchTalkContextRule(input: {
  talkId: string;
  ruleId: string;
  ruleText?: string;
  isActive?: boolean;
  sortOrder?: number;
}): Promise<ContextRule> {
  const { talkId, ruleId, ...patch } = input;
  const envelope = await apiMutationRequest<{ rule: ContextRule }>(
    `/api/v1/talks/${encodeURIComponent(talkId)}/context/rules/${encodeURIComponent(ruleId)}`,
    {
      method: 'PATCH',
      includeJson: true,
      body: JSON.stringify(patch),
    },
  );
  return envelope.rule;
}

export async function deleteTalkContextRule(input: {
  talkId: string;
  ruleId: string;
}): Promise<void> {
  await apiMutationRequest<{ deleted: true }>(
    `/api/v1/talks/${encodeURIComponent(input.talkId)}/context/rules/${encodeURIComponent(input.ruleId)}`,
    { method: 'DELETE' },
  );
}

export async function listTalkJobs(talkId: string): Promise<TalkJob[]> {
  const envelope = await apiRequest<{ jobs: TalkJob[] }>(
    `/api/v1/talks/${encodeURIComponent(talkId)}/jobs`,
  );
  return envelope.jobs;
}

export async function getTalkJob(input: {
  talkId: string;
  jobId: string;
}): Promise<TalkJob> {
  const envelope = await apiRequest<{ job: TalkJob }>(
    `/api/v1/talks/${encodeURIComponent(input.talkId)}/jobs/${encodeURIComponent(input.jobId)}`,
  );
  return envelope.job;
}

export async function listTalkJobRuns(input: {
  talkId: string;
  jobId: string;
  limit?: number;
}): Promise<TalkJobRunSummary[]> {
  const params = new URLSearchParams();
  if (typeof input.limit === 'number' && input.limit > 0) {
    params.set('limit', String(Math.floor(input.limit)));
  }
  const query = params.toString();
  const envelope = await apiRequest<{ runs: TalkJobRunSummary[] }>(
    `/api/v1/talks/${encodeURIComponent(input.talkId)}/jobs/${encodeURIComponent(input.jobId)}/runs${query ? `?${query}` : ''}`,
  );
  return envelope.runs;
}

export async function createTalkJob(input: {
  talkId: string;
  title: string;
  prompt: string;
  targetAgentId: string;
  schedule: TalkJobSchedule;
  timezone: string;
  sourceScope: TalkJobScope;
}): Promise<TalkJob> {
  const envelope = await apiMutationRequest<{ job: TalkJob }>(
    `/api/v1/talks/${encodeURIComponent(input.talkId)}/jobs`,
    {
      method: 'POST',
      includeJson: true,
      body: JSON.stringify(input),
    },
  );
  return envelope.job;
}

export async function patchTalkJob(input: {
  talkId: string;
  jobId: string;
  title?: string;
  prompt?: string;
  targetAgentId?: string;
  schedule?: TalkJobSchedule;
  timezone?: string;
  sourceScope?: TalkJobScope;
}): Promise<TalkJob> {
  const { talkId, jobId, ...patch } = input;
  const envelope = await apiMutationRequest<{ job: TalkJob }>(
    `/api/v1/talks/${encodeURIComponent(talkId)}/jobs/${encodeURIComponent(jobId)}`,
    {
      method: 'PATCH',
      includeJson: true,
      body: JSON.stringify(patch),
    },
  );
  return envelope.job;
}

export async function deleteTalkJob(input: {
  talkId: string;
  jobId: string;
}): Promise<void> {
  await apiMutationRequest<{ deleted: true }>(
    `/api/v1/talks/${encodeURIComponent(input.talkId)}/jobs/${encodeURIComponent(input.jobId)}`,
    { method: 'DELETE' },
  );
}

export async function pauseTalkJob(input: {
  talkId: string;
  jobId: string;
}): Promise<TalkJob> {
  const envelope = await apiMutationRequest<{ job: TalkJob }>(
    `/api/v1/talks/${encodeURIComponent(input.talkId)}/jobs/${encodeURIComponent(input.jobId)}/pause`,
    { method: 'POST' },
  );
  return envelope.job;
}

export async function resumeTalkJob(input: {
  talkId: string;
  jobId: string;
}): Promise<TalkJob> {
  const envelope = await apiMutationRequest<{ job: TalkJob }>(
    `/api/v1/talks/${encodeURIComponent(input.talkId)}/jobs/${encodeURIComponent(input.jobId)}/resume`,
    { method: 'POST' },
  );
  return envelope.job;
}

export async function runTalkJobNow(input: {
  talkId: string;
  jobId: string;
}): Promise<{ job: TalkJob; runId: string; triggerMessageId: null }> {
  return apiMutationRequest<{
    job: TalkJob;
    runId: string;
    triggerMessageId: null;
  }>(
    `/api/v1/talks/${encodeURIComponent(input.talkId)}/jobs/${encodeURIComponent(input.jobId)}/run-now`,
    { method: 'POST' },
  );
}

export async function createTalkContextSource(input: {
  talkId: string;
  sourceType: 'url' | 'file' | 'text';
  title: string;
  note?: string | null;
  sourceUrl?: string | null;
  extractedText?: string | null;
}): Promise<ContextSource> {
  const envelope = await apiMutationRequest<{ source: ContextSource }>(
    `/api/v1/talks/${encodeURIComponent(input.talkId)}/context/sources`,
    {
      method: 'POST',
      includeJson: true,
      body: JSON.stringify({
        sourceType: input.sourceType,
        title: input.title,
        note: input.note,
        sourceUrl: input.sourceUrl,
        extractedText: input.extractedText,
      }),
    },
  );
  return envelope.source;
}

export async function patchTalkContextSource(input: {
  talkId: string;
  sourceId: string;
  title?: string;
  note?: string | null;
  sortOrder?: number;
  extractedText?: string | null;
}): Promise<ContextSource> {
  const { talkId, sourceId, ...patch } = input;
  const envelope = await apiMutationRequest<{ source: ContextSource }>(
    `/api/v1/talks/${encodeURIComponent(talkId)}/context/sources/${encodeURIComponent(sourceId)}`,
    {
      method: 'PATCH',
      includeJson: true,
      body: JSON.stringify(patch),
    },
  );
  return envelope.source;
}

export async function deleteTalkContextSource(input: {
  talkId: string;
  sourceId: string;
}): Promise<void> {
  await apiMutationRequest<{ deleted: true }>(
    `/api/v1/talks/${encodeURIComponent(input.talkId)}/context/sources/${encodeURIComponent(input.sourceId)}`,
    { method: 'DELETE' },
  );
}

export async function retryTalkContextSource(input: {
  talkId: string;
  sourceId: string;
}): Promise<ContextSource> {
  const envelope = await apiMutationRequest<{ source: ContextSource }>(
    `/api/v1/talks/${encodeURIComponent(input.talkId)}/context/sources/${encodeURIComponent(input.sourceId)}/retry`,
    {
      method: 'POST',
    },
  );
  return envelope.source;
}

export async function uploadTalkContextSource(
  talkId: string,
  file: File,
  title?: string,
): Promise<ContextSource> {
  const formData = new FormData();
  formData.append('file', file);
  if (title) {
    formData.append('title', title);
  }
  const envelope = await apiMutationRequest<{ source: ContextSource }>(
    `/api/v1/talks/${encodeURIComponent(talkId)}/context/sources/upload`,
    {
      method: 'POST',
      body: formData,
    },
  );
  return envelope.source;
}

export function getContextSourceContentUrl(
  talkId: string,
  sourceId: string,
): string {
  return `/api/v1/talks/${encodeURIComponent(talkId)}/context/sources/${encodeURIComponent(sourceId)}/content`;
}

export type PageImageUploadResult = {
  uploaded: number;
  expected: number;
  complete: boolean;
};

/**
 * Upload one rasterized PDF page JPEG to a saved source. One page per
 * request (the Worker isolate can't buffer ~20 JPEGs in one multipart);
 * `?total` records the expected page count N so the server can mark the
 * set complete at `count == N`. Raw `image/jpeg` body, not multipart.
 */
export async function uploadSourcePageImage(input: {
  talkId: string;
  sourceId: string;
  pageIndex: number;
  totalPages: number;
  jpeg: Blob;
}): Promise<PageImageUploadResult> {
  const envelope = await apiMutationRequest<PageImageUploadResult>(
    `/api/v1/talks/${encodeURIComponent(input.talkId)}/context/sources/${encodeURIComponent(
      input.sourceId,
    )}/page-images/${input.pageIndex}?total=${input.totalPages}`,
    {
      method: 'POST',
      headers: { 'content-type': 'image/jpeg' },
      body: input.jpeg,
    },
  );
  return envelope;
}

export async function updateDefaultClaudeModel(
  modelId: string,
  input?: { workspaceId?: string | null },
): Promise<AiAgentsPageData> {
  return apiMutationRequest<AiAgentsPageData>(
    withWorkspaceQuery('/api/v1/agents/default-claude', input?.workspaceId),
    {
      method: 'PUT',
      includeJson: true,
      body: JSON.stringify({ modelId }),
    },
  );
}

export async function saveAiProviderCredential(input: {
  providerId: string;
  workspaceId?: string | null;
  apiKey?: string | null;
  organizationId?: string | null;
  baseUrl?: string | null;
  authScheme?: 'x_api_key' | 'bearer';
  scope?: ProviderCredentialScope;
}): Promise<AgentProviderCard> {
  const { workspaceId, ...body } = input;
  const envelope = await apiMutationRequest<{ provider: AgentProviderCard }>(
    withWorkspaceQuery(
      `/api/v1/agents/providers/${encodeURIComponent(input.providerId)}`,
      workspaceId,
    ),
    {
      method: 'PUT',
      includeJson: true,
      body: JSON.stringify(body),
    },
  );
  return envelope.provider;
}

export async function verifyAiProviderCredential(
  providerId: string,
  scope: ProviderCredentialScope = 'user',
  input?: { workspaceId?: string | null },
): Promise<AgentProviderCard> {
  const query = new URLSearchParams();
  if (scope === 'workspace') query.set('scope', 'workspace');
  if (input?.workspaceId) query.set('workspaceId', input.workspaceId);
  const suffix = query.toString() ? `?${query.toString()}` : '';
  const envelope = await apiMutationRequest<{ provider: AgentProviderCard }>(
    `/api/v1/agents/providers/${encodeURIComponent(providerId)}/verify${suffix}`,
    {
      method: 'POST',
    },
  );
  return envelope.provider;
}

// ─── OAuth subscription flows ───────────────────────────────────

export interface AnthropicOauthInitiateResult {
  authorizationUrl: string;
  state: string;
}

export async function initiateAnthropicSubscriptionOauth(
  scope: ProviderCredentialScope = 'user',
  input?: { workspaceId?: string | null },
): Promise<AnthropicOauthInitiateResult> {
  return apiMutationRequest<AnthropicOauthInitiateResult>(
    '/api/v1/agents/providers/provider.anthropic/oauth/initiate',
    {
      method: 'POST',
      includeJson: true,
      body: JSON.stringify({ scope, workspaceId: input?.workspaceId }),
    },
  );
}

export interface AnthropicOauthCompleteResult {
  scope: ProviderCredentialScope;
  expiresAt: string;
}

export async function completeAnthropicSubscriptionOauth(input: {
  state: string;
  code: string;
}): Promise<AnthropicOauthCompleteResult> {
  return apiMutationRequest<AnthropicOauthCompleteResult>(
    '/api/v1/agents/providers/provider.anthropic/oauth/complete',
    {
      method: 'POST',
      includeJson: true,
      body: JSON.stringify(input),
    },
  );
}

export interface OpenAiCodexOauthInitiateResult {
  state: string;
  userCode: string;
  verificationUrl: string;
  pollIntervalSeconds: number;
  expiresAt: string;
}

export async function initiateOpenAiCodexSubscriptionOauth(
  scope: ProviderCredentialScope = 'user',
  input?: { workspaceId?: string | null },
): Promise<OpenAiCodexOauthInitiateResult> {
  return apiMutationRequest<OpenAiCodexOauthInitiateResult>(
    '/api/v1/agents/providers/provider.openai_codex/oauth/initiate',
    {
      method: 'POST',
      includeJson: true,
      body: JSON.stringify({ scope, workspaceId: input?.workspaceId }),
    },
  );
}

export type OpenAiCodexOauthPollResult =
  | { status: 'pending' }
  | {
      status: 'authorized';
      scope: ProviderCredentialScope;
      expiresAt: string;
    };

export async function pollOpenAiCodexSubscriptionOauth(input: {
  state: string;
}): Promise<OpenAiCodexOauthPollResult> {
  return apiMutationRequest<OpenAiCodexOauthPollResult>(
    '/api/v1/agents/providers/provider.openai_codex/oauth/poll',
    {
      method: 'POST',
      includeJson: true,
      body: JSON.stringify(input),
    },
  );
}

export async function getTalkLlmSettings(): Promise<TalkLlmSettings> {
  return apiRequest<TalkLlmSettings>('/api/v1/settings/talk-llm');
}

export async function updateTalkLlmSettings(
  update: TalkLlmSettingsUpdate,
): Promise<TalkLlmSettings> {
  return apiMutationRequest<TalkLlmSettings>('/api/v1/settings/talk-llm', {
    method: 'PUT',
    includeJson: true,
    body: JSON.stringify(update),
  });
}

// ---------------------------------------------------------------------------
// (Main Channel removed — the legacy Nanoclaw routes were retired during
// the Phase 5 cloud port. The new Main is a regular Talk addressed via
// /app/main; the sidebar tree endpoint exposes mainTalkId for routing.)
// ---------------------------------------------------------------------------

export async function getHealthStatus(): Promise<boolean> {
  try {
    const response = await fetch('/api/v1/health', {
      method: 'GET',
      credentials: 'include',
      headers: {
        accept: 'application/json',
      },
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function sendTalkMessage(input: {
  workspaceId?: string | null;
  talkId: string;
  content: string;
  targetAgentIds?: string[];
  attachmentIds?: string[];
  threadId?: string | null;
}): Promise<{ talkId: string; message: TalkMessage; runs: TalkRun[] }> {
  return apiMutationRequest<{
    talkId: string;
    message: TalkMessage;
    runs: TalkRun[];
  }>(
    withWorkspaceQuery(
      `/api/v1/talks/${encodeURIComponent(input.talkId)}/chat`,
      input.workspaceId,
    ),
    {
      method: 'POST',
      includeJson: true,
      body: JSON.stringify({
        content: input.content,
        targetAgentIds: input.targetAgentIds ?? [],
        attachmentIds: input.attachmentIds ?? [],
        threadId: input.threadId ?? null,
      }),
    },
  );
}

export async function uploadTalkAttachment(
  _talkId: string,
  _file: File,
): Promise<{ attachment: TalkMessageAttachment }> {
  throw new ApiError(
    'Message attachments are not available on the greenfield chat route yet.',
    501,
    'attachments_not_available',
  );
}

export async function deleteTalkAttachment(
  _talkId: string,
  _attachmentId: string,
): Promise<void> {
  throw new ApiError(
    'Message attachments are not available on the greenfield chat route yet.',
    501,
    'attachments_not_available',
  );
}

export type ContentImageUploadPayload =
  | { dataUrl: string }
  | { sourceUrl: string };

export type ContentImageUploadResult = {
  url: string;
  key: string;
};

// Upload an inline content image to the CONTENT_IMAGES R2 bucket via
// POST /api/v1/content-images. Backs the rich-text editor's
// ContentImageUploaderPlugin: dataUrl for clipboard pastes, sourceUrl
// for rehosting an external image the editor saw during a paste.
//
// The optional AbortSignal is forwarded straight to fetch, so the
// caller can cancel an in-flight upload (plugin destroy / route
// navigation) and the request will throw an AbortError.
export async function uploadContentImage(
  payload: ContentImageUploadPayload,
  options?: { signal?: AbortSignal },
): Promise<ContentImageUploadResult> {
  return apiMutationRequest<ContentImageUploadResult>(
    '/api/v1/content-images',
    {
      method: 'POST',
      includeJson: true,
      body: JSON.stringify(payload),
      signal: options?.signal,
    },
  );
}

export async function cancelTalkRuns(
  talkId: string,
  threadId?: string | null,
  input?: WorkspaceScopedRequest,
): Promise<{ talkId: string; cancelledRuns: number }> {
  return apiMutationRequest<{ talkId: string; cancelledRuns: number }>(
    withWorkspaceQuery(
      `/api/v1/talks/${encodeURIComponent(talkId)}/chat/cancel`,
      input?.workspaceId,
    ),
    {
      method: 'POST',
      includeJson: true,
      body: JSON.stringify(threadId ? { threadId } : {}),
    },
  );
}

export async function logout(): Promise<void> {
  await apiMutationRequest<{ loggedOut: boolean }>(AUTH_LOGOUT_PATH, {
    method: 'POST',
  });
}

// ---------------------------------------------------------------------------
// Browser profiles
// ---------------------------------------------------------------------------

export type BrowserConnectionMode = 'managed' | 'chrome_profile' | 'cdp';

export type ChromeUserDataDirectoryCandidate = {
  id: string;
  label: string;
  path: string;
  preferred: boolean;
};

export type ChromeUserDataDirectoryDiscovery = {
  platform: string;
  defaultPathHint: string | null;
  candidates: ChromeUserDataDirectoryCandidate[];
};

export type ChromeSubprofileCandidate = {
  directoryName: string;
  displayName: string;
  email: string | null;
  fullName: string | null;
  kind: 'default' | 'profile' | 'guest' | 'system' | 'other';
  preferred: boolean;
  lastUsed: boolean;
  path: string;
};

export type ChromeSubprofileDiscovery = {
  userDataDir: string;
  localStateFound: boolean;
  candidates: ChromeSubprofileCandidate[];
};

export type BrowserProfileSummary = {
  id: string;
  siteKey: string;
  accountLabel: string | null;
  connectionMode: BrowserConnectionMode;
  connectionConfig:
    | { mode: 'managed' }
    | {
        mode: 'chrome_profile';
        chromeProfilePath: string;
        profileDirectory?: string;
      }
    | { mode: 'cdp'; endpointUrl: string };
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
  inUseSessionCount: number;
  currentSessionState: 'active' | 'blocked' | 'takeover' | null;
};

export async function listBrowserProfiles(): Promise<BrowserProfileSummary[]> {
  const envelope = await apiRequest<{ profiles: BrowserProfileSummary[] }>(
    '/api/v1/browser/profiles',
  );
  return envelope.profiles;
}

export async function discoverChromeUserDataDirectories(): Promise<ChromeUserDataDirectoryDiscovery> {
  return apiRequest<ChromeUserDataDirectoryDiscovery>(
    '/api/v1/browser/discovery/chrome-user-data',
  );
}

export async function discoverChromeSubprofiles(
  userDataDir: string,
): Promise<ChromeSubprofileDiscovery> {
  return apiRequest<ChromeSubprofileDiscovery>(
    `/api/v1/browser/discovery/chrome-profiles?userDataDir=${encodeURIComponent(userDataDir)}`,
  );
}

export async function createBrowserProfile(input: {
  siteKey: string;
  accountLabel?: string | null;
  connectionMode?: BrowserConnectionMode;
  connectionConfig?: Record<string, unknown>;
}): Promise<{ profile: BrowserProfileSummary; created: boolean }> {
  return apiMutationRequest<{
    profile: BrowserProfileSummary;
    created: boolean;
  }>('/api/v1/browser/profiles', {
    method: 'POST',
    includeJson: true,
    body: JSON.stringify(input),
  });
}

export async function updateBrowserProfileConnectionMode(
  profileId: string,
  connectionMode: BrowserConnectionMode,
  connectionConfig?: Record<string, unknown>,
): Promise<BrowserProfileSummary> {
  const envelope = await apiMutationRequest<{ profile: BrowserProfileSummary }>(
    `/api/v1/browser/profiles/${encodeURIComponent(profileId)}`,
    {
      method: 'PATCH',
      includeJson: true,
      body: JSON.stringify({ connectionMode, connectionConfig }),
    },
  );
  return envelope.profile;
}

export async function deleteBrowserProfile(
  profileId: string,
): Promise<{ profileId: string }> {
  return apiMutationRequest<{ profileId: string }>(
    `/api/v1/browser/profiles/${encodeURIComponent(profileId)}`,
    {
      method: 'DELETE',
    },
  );
}

export async function releaseBrowserProfileSessions(
  profileId: string,
): Promise<{
  releasedCount: number;
  liveReleasedCount: number;
  staleReleasedCount: number;
}> {
  return apiMutationRequest<{
    releasedCount: number;
    liveReleasedCount: number;
    staleReleasedCount: number;
  }>(
    `/api/v1/browser/profiles/${encodeURIComponent(profileId)}/release-sessions`,
    {
      method: 'POST',
      includeJson: true,
      body: '{}',
    },
  );
}

async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  return apiRequestWithRefresh<T>(path, init, true);
}

type MutationRequestInit = Omit<RequestInit, 'headers'> & {
  headers?: HeadersInit;
  includeJson?: boolean;
};

type MutationRetryState = {
  allowAuthRetry: boolean;
  allowCsrfRetry: boolean;
  idempotencyKey: string;
};

async function apiMutationRequest<T>(
  path: string,
  init?: MutationRequestInit,
): Promise<T> {
  return apiMutationRequestWithRefresh<T>(path, init, {
    allowAuthRetry: true,
    allowCsrfRetry: true,
    idempotencyKey: buildIdempotencyKey(),
  });
}

async function apiRequestWithRefresh<T>(
  path: string,
  init: RequestInit | undefined,
  allowRefreshRetry: boolean,
): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: 'include',
    headers: {
      accept: 'application/json',
      ...activeWorkspaceHeaders(path, init?.headers),
      ...(init?.headers || {}),
    },
  });

  if (response.status === 401) {
    if (allowRefreshRetry && !shouldSkipRefresh(path)) {
      const refreshed = await ensureRefreshedSession();
      if (refreshed) {
        return apiRequestWithRefresh<T>(path, init, false);
      }
    }
    throw new UnauthorizedError();
  }

  const payload = (await response.json()) as ApiEnvelope<T>;
  if (!response.ok || !payload.ok) {
    const message =
      !payload.ok && payload.error?.message
        ? payload.error.message
        : `Request failed with status ${response.status}`;
    const code = !payload.ok ? payload.error?.code : undefined;
    throw new ApiError(message, response.status, code);
  }
  return payload.data;
}

async function apiMutationRequestWithRefresh<T>(
  path: string,
  init: MutationRequestInit | undefined,
  retryState: MutationRetryState,
): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: 'include',
    headers: buildMutationAttemptHeaders({
      includeJson: init?.includeJson === true,
      explicitHeaders: init?.headers,
      idempotencyKey: retryState.idempotencyKey,
      path,
    }),
  });

  if (response.status === 401) {
    if (retryState.allowAuthRetry && !shouldSkipRefresh(path)) {
      const refreshed = await ensureRefreshedSession();
      if (refreshed) {
        return apiMutationRequestWithRefresh<T>(path, init, {
          ...retryState,
          allowAuthRetry: false,
        });
      }
    }
    throw new UnauthorizedError();
  }

  const payload = (await response.json()) as ApiEnvelope<T>;

  if (
    response.status === 403 &&
    !payload.ok &&
    payload.error?.code === 'csrf_failed' &&
    retryState.allowCsrfRetry &&
    !shouldSkipRefresh(path)
  ) {
    const refreshed = await ensureRefreshedSession();
    if (refreshed) {
      return apiMutationRequestWithRefresh<T>(path, init, {
        ...retryState,
        allowAuthRetry: false,
        allowCsrfRetry: false,
      });
    }
  }

  if (!response.ok || !payload.ok) {
    const message =
      !payload.ok && payload.error?.message
        ? payload.error.message
        : `Request failed with status ${response.status}`;
    const code = !payload.ok ? payload.error?.code : undefined;
    throw new ApiError(message, response.status, code);
  }
  return payload.data;
}

function shouldSkipRefresh(path: string): boolean {
  const normalizedPath = path.split('?')[0];
  // Logout intentionally skips refresh-based recovery so we never revive the
  // same session the user is actively trying to end.
  return (
    normalizedPath === AUTH_REFRESH_PATH || normalizedPath === AUTH_LOGOUT_PATH
  );
}

async function ensureRefreshedSession(): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = doRefresh();
  try {
    return await refreshInFlight;
  } finally {
    refreshInFlight = null;
  }
}

async function doRefresh(): Promise<boolean> {
  // Prefer supabase-js's refresh path. It serializes via processLock
  // with the background autoRefreshToken timer, so we don't race the
  // single-use refresh-token rotation by calling /api/v1/auth/refresh
  // separately. Cookie sync happens via POST /api/v1/auth/callback
  // right after, before we resolve, so the retried request finds a
  // fresh eb_at.
  if (isSupabaseConfigured()) {
    const refreshed = await refreshViaSupabase();
    if (refreshed) return true;
    // supabase-js had nothing to refresh (no localStorage session yet
    // or it was wiped). Fall through to the cookie-only path so users
    // with a valid eb_rt cookie but no localStorage session can still
    // recover. Background autoRefreshToken isn't running in this case
    // (no session to refresh), so no race.
  }
  return refreshViaServerEndpoint();
}

async function refreshViaSupabase(): Promise<boolean> {
  try {
    const { data, error } = await getSupabaseClient().auth.refreshSession();
    if (error || !data.session) return false;
    const res = await fetch(AUTH_CALLBACK_PATH, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        accessToken: data.session.access_token,
        refreshToken: data.session.refresh_token,
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function refreshViaServerEndpoint(): Promise<boolean> {
  try {
    const response = await fetch(AUTH_REFRESH_PATH, {
      method: 'POST',
      credentials: 'include',
      headers: {
        accept: 'application/json',
      },
    });
    if (response.status === 401 || !response.ok) return false;

    const payload = (await response
      .json()
      .catch(() => null)) as ApiEnvelope<unknown> | null;
    return Boolean(payload?.ok);
  } catch {
    return false;
  }
}

// Default each workspace-scoped request to the user's active workspace via the
// `x-workspace-id` header. The backend has no persisted active workspace, so
// the client carries it per request. Never overrides an explicit per-call
// workspace (a `?workspaceId=` query param or an x-workspace-id header), so
// calls that target a specific workspace keep working.
function activeWorkspaceHeaders(
  path: string,
  explicitHeaders?: HeadersInit,
): Record<string, string> {
  const existing = new Headers(explicitHeaders);
  if (
    existing.has('x-workspace-id') ||
    existing.has('x-clawtalk-workspace-id') ||
    /[?&]workspaceId=/.test(path)
  ) {
    return {};
  }
  const workspaceId = getActiveWorkspaceId();
  return workspaceId ? { 'x-workspace-id': workspaceId } : {};
}

function buildMutationAttemptHeaders(input: {
  includeJson: boolean;
  explicitHeaders?: HeadersInit;
  idempotencyKey: string;
  path: string;
}): HeadersInit {
  const headers = new Headers();
  headers.set('accept', 'application/json');

  if (input.explicitHeaders) {
    const explicitHeaders = new Headers(input.explicitHeaders);
    explicitHeaders.forEach((value, key) => {
      headers.set(key, value);
    });
  }

  if (input.includeJson && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }

  const workspaceHeaders = activeWorkspaceHeaders(
    input.path,
    input.explicitHeaders,
  );
  if (workspaceHeaders['x-workspace-id']) {
    headers.set('x-workspace-id', workspaceHeaders['x-workspace-id']);
  }

  // Caller headers may supply generic metadata, but CSRF and idempotency are
  // always owned by this wrapper and written last from current cookie state.
  const csrfToken = getCsrfTokenFromCookie();
  if (csrfToken) {
    headers.set('x-csrf-token', csrfToken);
  } else {
    headers.delete('x-csrf-token');
  }

  headers.set('idempotency-key', input.idempotencyKey);
  return headers;
}

function getCsrfTokenFromCookie(): string | null {
  if (!globalThis.document?.cookie) return null;
  // Prefer the cloud-era eb_csrf cookie (set by /api/v1/auth/callback);
  // fall back to the sqlite-era cr_csrf_token name until the legacy
  // node server is retired by the caller swap.
  const entries = document.cookie.split(';').map((entry) => entry.trim());
  const tokenPair =
    entries.find((entry) => entry.startsWith('eb_csrf=')) ??
    entries.find((entry) => entry.startsWith('cr_csrf_token='));
  if (!tokenPair) return null;

  const [, value = ''] = tokenPair.split('=', 2);
  if (!value) return null;

  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function buildIdempotencyKey(): string {
  const randomUUID = globalThis.crypto?.randomUUID;
  if (typeof randomUUID === 'function') {
    return randomUUID.call(globalThis.crypto);
  }
  return `idem-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

// ---------------------------------------------------------------------------
// Workspace connectors (channels + data connectors).
// ---------------------------------------------------------------------------

export type ChannelKind = 'slack';

export type DataConnectorKind = 'google_docs' | 'google_sheets';

export type WorkspaceChannel = {
  id: string;
  kind: ChannelKind;
  displayName: string;
  config: Record<string, unknown>;
  hasCredential: boolean;
  enabled: boolean;
  boundTalkCount: number;
  createdAt: string;
  updatedAt: string;
  createdBy: string | null;
  updatedBy: string | null;
};

export type WorkspaceDataConnector = {
  id: string;
  kind: DataConnectorKind;
  displayName: string;
  config: Record<string, unknown>;
  hasCredential: boolean;
  enabled: boolean;
  boundTalkCount: number;
  createdAt: string;
  updatedAt: string;
  createdBy: string | null;
  updatedBy: string | null;
};

export type TalkConnectorChannelRow = {
  id: string;
  kind: ChannelKind;
  displayName: string;
  enabled: boolean;
  hasCredential: boolean;
  linked: boolean;
};

export type TalkConnectorDataConnectorRow = {
  id: string;
  kind: DataConnectorKind;
  displayName: string;
  enabled: boolean;
  hasCredential: boolean;
  linked: boolean;
};

export type TalkConnectorsView = {
  channels: TalkConnectorChannelRow[];
  dataConnectors: TalkConnectorDataConnectorRow[];
};

export type WorkspaceSlackInstall = {
  teamId: string;
  teamName: string;
  botUserId: string | null;
  appId: string | null;
  scopes: string[];
  installedBy: string | null;
  installedAt: string;
  updatedAt: string;
  boundChannelCount: number;
};

export type SlackInstallAuthorizationLaunch = {
  authorizationUrl: string;
  expiresInSec: number;
};

export async function listWorkspaceChannels(
  input?: WorkspaceScopedRequest,
): Promise<WorkspaceChannel[]> {
  const envelope = await apiRequest<{ channels: WorkspaceChannel[] }>(
    withWorkspaceQuery('/api/v1/workspace/channels', input?.workspaceId),
  );
  return envelope.channels;
}

export async function createWorkspaceChannel(input: {
  workspaceId?: string | null;
  kind: ChannelKind;
  displayName: string;
  config: Record<string, unknown>;
  enabled?: boolean;
}): Promise<WorkspaceChannel> {
  const { workspaceId, ...body } = input;
  const envelope = await apiMutationRequest<{ channel: WorkspaceChannel }>(
    withWorkspaceQuery('/api/v1/workspace/channels', workspaceId),
    {
      method: 'POST',
      includeJson: true,
      body: JSON.stringify(body),
    },
  );
  return envelope.channel;
}

export async function updateWorkspaceChannel(input: {
  workspaceId?: string | null;
  channelId: string;
  displayName?: string;
  config?: Record<string, unknown>;
  enabled?: boolean;
}): Promise<WorkspaceChannel> {
  const { workspaceId, channelId, ...patch } = input;
  const envelope = await apiMutationRequest<{ channel: WorkspaceChannel }>(
    withWorkspaceQuery(
      `/api/v1/workspace/channels/${encodeURIComponent(channelId)}`,
      workspaceId,
    ),
    {
      method: 'PATCH',
      includeJson: true,
      body: JSON.stringify(patch),
    },
  );
  return envelope.channel;
}

export async function deleteWorkspaceChannel(
  channelId: string,
  input?: WorkspaceScopedRequest,
): Promise<void> {
  await apiMutationRequest<{ deleted: true }>(
    withWorkspaceQuery(
      `/api/v1/workspace/channels/${encodeURIComponent(channelId)}`,
      input?.workspaceId,
    ),
    {
      method: 'DELETE',
    },
  );
}

export async function setWorkspaceChannelCredential(input: {
  workspaceId?: string | null;
  channelId: string;
  apiKey: string | null;
  organizationId?: string;
}): Promise<WorkspaceChannel> {
  const envelope = await apiMutationRequest<{ channel: WorkspaceChannel }>(
    withWorkspaceQuery(
      `/api/v1/workspace/channels/${encodeURIComponent(input.channelId)}/credential`,
      input.workspaceId,
    ),
    {
      method: 'PUT',
      includeJson: true,
      body: JSON.stringify({
        apiKey: input.apiKey,
        ...(input.organizationId
          ? { organizationId: input.organizationId }
          : {}),
      }),
    },
  );
  return envelope.channel;
}

export async function listWorkspaceDataConnectors(
  input?: WorkspaceScopedRequest,
): Promise<WorkspaceDataConnector[]> {
  const envelope = await apiRequest<{
    dataConnectors: WorkspaceDataConnector[];
  }>(
    withWorkspaceQuery('/api/v1/workspace/data-connectors', input?.workspaceId),
  );
  return envelope.dataConnectors;
}

export async function createWorkspaceDataConnector(input: {
  workspaceId?: string | null;
  kind: DataConnectorKind;
  displayName: string;
  config: Record<string, unknown>;
  enabled?: boolean;
}): Promise<WorkspaceDataConnector> {
  const { workspaceId, ...body } = input;
  const envelope = await apiMutationRequest<{
    dataConnector: WorkspaceDataConnector;
  }>(withWorkspaceQuery('/api/v1/workspace/data-connectors', workspaceId), {
    method: 'POST',
    includeJson: true,
    body: JSON.stringify(body),
  });
  return envelope.dataConnector;
}

export async function updateWorkspaceDataConnector(input: {
  workspaceId?: string | null;
  connectorId: string;
  displayName?: string;
  config?: Record<string, unknown>;
  enabled?: boolean;
}): Promise<WorkspaceDataConnector> {
  const { workspaceId, connectorId, ...patch } = input;
  const envelope = await apiMutationRequest<{
    dataConnector: WorkspaceDataConnector;
  }>(
    withWorkspaceQuery(
      `/api/v1/workspace/data-connectors/${encodeURIComponent(connectorId)}`,
      workspaceId,
    ),
    {
      method: 'PATCH',
      includeJson: true,
      body: JSON.stringify(patch),
    },
  );
  return envelope.dataConnector;
}

export async function deleteWorkspaceDataConnector(
  connectorId: string,
  input?: WorkspaceScopedRequest,
): Promise<void> {
  await apiMutationRequest<{ deleted: true }>(
    withWorkspaceQuery(
      `/api/v1/workspace/data-connectors/${encodeURIComponent(connectorId)}`,
      input?.workspaceId,
    ),
    {
      method: 'DELETE',
    },
  );
}

export async function setWorkspaceDataConnectorCredential(input: {
  workspaceId?: string | null;
  connectorId: string;
  apiKey: string | null;
  organizationId?: string;
}): Promise<WorkspaceDataConnector> {
  const envelope = await apiMutationRequest<{
    dataConnector: WorkspaceDataConnector;
  }>(
    withWorkspaceQuery(
      `/api/v1/workspace/data-connectors/${encodeURIComponent(input.connectorId)}/credential`,
      input.workspaceId,
    ),
    {
      method: 'PUT',
      includeJson: true,
      body: JSON.stringify({
        apiKey: input.apiKey,
        ...(input.organizationId
          ? { organizationId: input.organizationId }
          : {}),
      }),
    },
  );
  return envelope.dataConnector;
}

export async function getTalkConnectors(
  talkId: string,
): Promise<TalkConnectorsView> {
  return apiRequest<TalkConnectorsView>(
    `/api/v1/talks/${encodeURIComponent(talkId)}/connectors`,
  );
}

export async function listWorkspaceSlackInstalls(
  input?: WorkspaceScopedRequest,
): Promise<WorkspaceSlackInstall[]> {
  const envelope = await apiRequest<{ installs: WorkspaceSlackInstall[] }>(
    withWorkspaceQuery(
      '/api/v1/workspace/connectors/slack/installs',
      input?.workspaceId,
    ),
  );
  return envelope.installs;
}

export async function connectWorkspaceSlackInstall(input?: {
  returnTo?: string;
  workspaceId?: string | null;
}): Promise<SlackInstallAuthorizationLaunch> {
  return apiMutationRequest<SlackInstallAuthorizationLaunch>(
    withWorkspaceQuery(
      '/api/v1/workspace/connectors/slack/installs/connect',
      input?.workspaceId,
    ),
    {
      method: 'POST',
      includeJson: true,
      body: JSON.stringify({ returnTo: input?.returnTo }),
    },
  );
}

export async function deleteWorkspaceSlackInstall(
  teamId: string,
  input?: WorkspaceScopedRequest,
): Promise<void> {
  await apiMutationRequest<{ deleted: boolean }>(
    withWorkspaceQuery(
      `/api/v1/workspace/connectors/slack/installs/${encodeURIComponent(teamId)}`,
      input?.workspaceId,
    ),
    {
      method: 'DELETE',
    },
  );
}

export type SlackChannelOption = {
  id: string;
  name: string;
  isPrivate: boolean;
  isMember: boolean;
  numMembers: number | null;
  topic: string | null;
  alreadyAdded: boolean;
};

export async function listSlackInstallChannels(
  teamId: string,
  input?: WorkspaceScopedRequest,
): Promise<SlackChannelOption[]> {
  const envelope = await apiRequest<{ channels: SlackChannelOption[] }>(
    withWorkspaceQuery(
      `/api/v1/workspace/connectors/slack/installs/${encodeURIComponent(teamId)}/channels`,
      input?.workspaceId,
    ),
  );
  return envelope.channels;
}

export type SlackChannelPickInput = {
  channelId: string;
  channelName: string;
  isPrivate: boolean;
  displayName?: string;
};

export type SlackChannelAddResult = {
  id: string;
  channelId: string;
  displayName: string;
};

export async function bulkAddSlackChannels(input: {
  workspaceId?: string | null;
  teamId: string;
  channels: SlackChannelPickInput[];
}): Promise<SlackChannelAddResult[]> {
  const envelope = await apiMutationRequest<{
    created: SlackChannelAddResult[];
  }>(
    withWorkspaceQuery(
      `/api/v1/workspace/connectors/slack/installs/${encodeURIComponent(input.teamId)}/channels`,
      input.workspaceId,
    ),
    {
      method: 'POST',
      includeJson: true,
      body: JSON.stringify({ channels: input.channels }),
    },
  );
  return envelope.created;
}

export async function setTalkChannelLink(input: {
  talkId: string;
  channelId: string;
}): Promise<void> {
  await apiMutationRequest<{ linked: true }>(
    `/api/v1/talks/${encodeURIComponent(input.talkId)}/connectors/channels/${encodeURIComponent(input.channelId)}`,
    {
      method: 'PUT',
    },
  );
}

export async function deleteTalkChannelLink(input: {
  talkId: string;
  channelId: string;
}): Promise<void> {
  await apiMutationRequest<{ unlinked: true }>(
    `/api/v1/talks/${encodeURIComponent(input.talkId)}/connectors/channels/${encodeURIComponent(input.channelId)}`,
    {
      method: 'DELETE',
    },
  );
}

export async function setTalkDataConnectorLink(input: {
  talkId: string;
  connectorId: string;
}): Promise<void> {
  await apiMutationRequest<{ linked: true }>(
    `/api/v1/talks/${encodeURIComponent(input.talkId)}/connectors/data-connectors/${encodeURIComponent(input.connectorId)}`,
    {
      method: 'PUT',
    },
  );
}

export async function deleteTalkDataConnectorLink(input: {
  talkId: string;
  connectorId: string;
}): Promise<void> {
  await apiMutationRequest<{ unlinked: true }>(
    `/api/v1/talks/${encodeURIComponent(input.talkId)}/connectors/data-connectors/${encodeURIComponent(input.connectorId)}`,
    {
      method: 'DELETE',
    },
  );
}

// ─── Home (read-only attention surface) ─────────────────────────────────
// Mirrors src/clawtalk/db/home-accessors.ts payload types. Only the read API
// (GET /api/v1/home/*) exists today; inbox/recommendation/news lifecycle write
// endpoints are not implemented yet, so this client is read-only.

export type HomeInboxType =
  | 'agent_replied'
  | 'round_completed'
  | 'agent_asks_user'
  | 'run_failed'
  | 'doc_edits_ready'
  | 'connector_needs_auth'
  | 'news_context_added'
  | 'long_running_run'
  | 'system_limit_reached'
  | 'forge_run_needs_review'
  | 'job_output_ready'
  | 'job_blocked';

export type HomeInboxSeverity = 'info' | 'action' | 'blocking';
export type HomeInboxStatus =
  | 'unread'
  | 'read'
  | 'resolved'
  | 'dismissed'
  | 'snoozed'
  | 'expired';

export type HomeRecommendationKind =
  | 'setup'
  | 'failed-run'
  | 'unresolved'
  | 'synthesis'
  | 'pending-edit'
  | 'doc'
  | 'cross-link'
  | 'tool'
  | 'news-context'
  | 'agent-change'
  | 'recap'
  | 'archive-cleanup'
  | 'forge-suggestion'
  | 'job'
  | 'prompt-suggestion';

export type HomeRecommendationPriority = 'decide' | 'improve' | 'tidy';
export type HomeRecommendationStatus =
  | 'active'
  | 'dismissed'
  | 'completed'
  | 'expired'
  | 'snoozed';

export type HomeNewsImpact =
  | 'changes_assumption'
  | 'adds_evidence'
  | 'updates_competitor'
  | 'introduces_risk'
  | 'provides_tactic'
  | 'topic_update'
  | 'community_signal'
  | 'background_only';

export type HomeAction = {
  type: string;
  label?: string;
  payload: Record<string, unknown>;
};

export type HomeInboxTarget = {
  kind: string;
  id?: string;
  talkId?: string;
  documentId?: string;
  runId?: string;
  tabId?: string;
  newsItemId?: string;
  connectorId?: string;
  jobId?: string;
};

export type HomeInboxItem = {
  id: string;
  type: HomeInboxType;
  title: string;
  summary: string | null;
  reason: string | null;
  severity: HomeInboxSeverity;
  status: HomeInboxStatus;
  target: HomeInboxTarget;
  primaryAction: HomeAction | null;
  secondaryActions: HomeAction[];
  score: number;
  createdAt: string;
  algorithmVersion: string;
};

export type HomeInboxCounts = {
  unread: number;
  blocking: number;
  action: number;
  info: number;
};

export type HomeInboxPayload = {
  items: HomeInboxItem[];
  counts: HomeInboxCounts;
  nextCursor: string | null;
  algorithmVersion: string;
};

export type HomeRecommendation = {
  id: string;
  kind: HomeRecommendationKind;
  title: string;
  why: string | null;
  priority: HomeRecommendationPriority;
  score: number;
  confidence: number;
  provenance: Record<string, unknown>;
  action: HomeAction;
  status: HomeRecommendationStatus;
  stateFingerprint: string | null;
  rank: number | null;
  algorithmVersion: string;
  createdAt: string;
  expiresAt: string | null;
};

export type HomeRecommendationsPayload = {
  items: HomeRecommendation[];
  hero: HomeRecommendation | null;
  thenMaybe: HomeRecommendation[];
  algorithmVersion: string;
};

export type HomeNewsItem = {
  id: string;
  headline: string;
  source: string | null;
  favicon: string | null;
  age: string | null;
  excerpt: string | null;
  url: string;
  talkId: string;
  talkTitle: string;
  matchedOn: string[];
  whyItMatters: string | null;
  impact: HomeNewsImpact;
  score: number;
  publishedAt: string | null;
  algorithmVersion: string;
};

export type HomeNewsPayload = {
  items: HomeNewsItem[];
  nextCursor: string | null;
  algorithmVersion: string;
};

export type HomeCuratorKind =
  | 'talk'
  | 'recommendation'
  | 'inbox'
  | 'news'
  | 'idle';

export type HomeSummaryPayload = {
  workspaceId: string;
  curator: {
    kind: HomeCuratorKind;
    title: string;
    summary: string | null;
    itemId: string | null;
    target: Record<string, unknown> | null;
  };
  stats: {
    talks: number;
    prompts: number;
    tokens: number;
    words: number;
  };
  counts: {
    inbox: HomeInboxCounts;
    recommendations: number;
    news: number;
  };
  algorithmVersions: {
    inbox: string;
    recommendations: string;
    news: string;
  };
};

function homeQueryString(params?: {
  limit?: number;
  cursor?: string | null;
}): string {
  const search = new URLSearchParams();
  if (params?.limit != null) search.set('limit', String(params.limit));
  if (params?.cursor) search.set('cursor', params.cursor);
  const serialized = search.toString();
  return serialized ? `?${serialized}` : '';
}

export async function getHomeSummary(): Promise<HomeSummaryPayload> {
  return apiRequest<HomeSummaryPayload>('/api/v1/home/summary');
}

export async function listHomeInbox(params?: {
  limit?: number;
  cursor?: string | null;
}): Promise<HomeInboxPayload> {
  return apiRequest<HomeInboxPayload>(
    `/api/v1/home/inbox${homeQueryString(params)}`,
  );
}

export async function listHomeRecommendations(params?: {
  limit?: number;
}): Promise<HomeRecommendationsPayload> {
  return apiRequest<HomeRecommendationsPayload>(
    `/api/v1/home/recommendations${homeQueryString(params)}`,
  );
}

export async function listHomeNews(params?: {
  limit?: number;
  cursor?: string | null;
}): Promise<HomeNewsPayload> {
  return apiRequest<HomeNewsPayload>(
    `/api/v1/home/news${homeQueryString(params)}`,
  );
}

export type HomeInboxMutationResult = {
  id: string;
  status: HomeInboxStatus;
};

export type HomeRecommendationMutationResult = {
  id: string;
  status: HomeRecommendationStatus;
};

/** Dismiss an Inbox item so it leaves the active Home Inbox. */
export async function dismissHomeInboxItem(
  itemId: string,
): Promise<HomeInboxMutationResult> {
  return apiMutationRequest<HomeInboxMutationResult>(
    `/api/v1/home/inbox/${encodeURIComponent(itemId)}/dismiss`,
    { method: 'POST' },
  );
}

/** Snooze an Inbox item until `until` (ISO-8601); it re-surfaces when due. */
export async function snoozeHomeInboxItem(
  itemId: string,
  until: string,
): Promise<HomeInboxMutationResult> {
  return apiMutationRequest<HomeInboxMutationResult>(
    `/api/v1/home/inbox/${encodeURIComponent(itemId)}/snooze`,
    { method: 'POST', includeJson: true, body: JSON.stringify({ until }) },
  );
}

/** Dismiss a recommendation so it leaves the Recommendations rail. */
export async function dismissHomeRecommendation(
  recommendationId: string,
): Promise<HomeRecommendationMutationResult> {
  return apiMutationRequest<HomeRecommendationMutationResult>(
    `/api/v1/home/recommendations/${encodeURIComponent(recommendationId)}/dismiss`,
    { method: 'POST' },
  );
}
