import {
  FormEvent,
  KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import {
  AgentProviderCard,
  AiAgentsPageData,
  ApiError,
  cancelTalkRuns,
  ContentSidebarItem,
  createTalkThread,
  deleteTalkMessages,
  deleteTalkThread,
  getAiAgents,
  getTalk,
  getTalkAgents,
  getTalkRunContext,
  getTalkRuns,
  listTalkThreads,
  listTalkMessages,
  searchTalkMessages,
  patchTalkMetadata,
  sendTalkMessage,
  Talk,
  TalkAgent,
  TalkMessage,
  TalkMessageSearchResult,
  TalkMessageAttachment,
  TalkRun,
  TalkSnapshot,
  TalkRunContextSnapshot,
  TalkThread,
  uploadTalkAttachment,
  updateTalkAgents,
  updateTalkThread,
  listRegisteredAgents,
  type RegisteredAgent,
  UnauthorizedError,
} from '../lib/api';
import { TalkToolsPanel } from '../components/TalkToolsPanel';
import { SavedSourcesPanel } from '../components/SavedSourcesPanel';
import { TalkContextPanel } from '../components/TalkContextPanel';
import {
  TalkJobsPanel,
  type JobAgentOption,
} from '../components/TalkJobsPanel';
import {
  buildSourceMentionOptions,
  type SourceMentionOption,
} from '../components/SourceMentionPicker';
import { TalkConnectorsPanel } from '../components/connectors/TalkConnectorsPanel';
import { TalkAgentsPanel } from '../components/TalkAgentsPanel';
import {
  TalkRunsPanel,
  type RunContextPanelState,
} from '../components/TalkRunsPanel';
import { TalkHistoryEditor } from '../components/TalkHistoryEditor';
import { TalkDetailShell } from '../components/Talk/TalkDetailShell';
import { TalkTabContent } from '../components/Talk/TalkTabContent';
import {
  formatTalkRole,
  buildAgentLabel,
  type AgentCreationDraft,
  type TalkAgentExecutionGuardrail,
} from '../lib/talkAgents';
import {
  getLastThreadForTalk,
  setLastThreadForTalk,
} from '../lib/lastThreadForTalk';
import {
  clearThreadScroll,
  loadThreadScroll,
  saveThreadScroll,
} from '../lib/threadScroll';
import { formatThreadLabel } from '../lib/threadTitles';
import { useTalkRunStream } from '../hooks/useTalkRunStream';
import {
  buildThreadHref,
  useTalkDetailRouteState,
  useTalkDetailTabLinks,
} from '../hooks/useTalkDetailTabs';
import { useTalkDocumentController } from '../hooks/useTalkDocumentController';
import { useTalkRunViewModel } from '../hooks/useTalkRunViewModel';
import { useTalkContextController } from '../hooks/useTalkContextController';
import { useTalkJobsController } from '../hooks/useTalkJobsController';
import { createInitialDetailState, detailReducer } from '../lib/talkRunReducer';
import { useQueryClient } from '@tanstack/react-query';
import {
  rememberActiveThreadForTalk,
  snapshotQueryKey,
  useTalkSnapshot,
} from '../lib/useTalkSnapshot';
import {
  appendTalkMessageToSnapshot,
  createWsCacheRouter,
  patchTalkInSnapshot,
  prependOlderTalkMessagesToSnapshot,
} from '../lib/wsCacheRouter';

type TalkOrchestrationMode = Talk['orchestrationMode'];

type ThreadListState = {
  threads: TalkThread[];
  loading: boolean;
  error: string | null;
};

const SCROLL_STICK_THRESHOLD_PX = 120;
const TALK_MESSAGE_MAX_CHARS = 20_000;
const COMPOSER_TEXTAREA_MIN_HEIGHT_PX = 48;
const COMPOSER_TEXTAREA_MAX_HEIGHT_PX = 240;
const GREENFIELD_MESSAGE_ATTACHMENTS_ENABLED = false;

type TalkAgentSourceOption = {
  id: string;
  label: string;
  sourceKind: 'claude_default' | 'provider';
  providerId: string | null;
};

const EMPTY_MESSAGES: TalkMessage[] = [];

// Stable conversion from the snapshot's wire shape to the webapp's Talk
// type (defaults `title` to '' and `agents` to []) so render-site reads
// against `snapshot.talk` get the same shape the old reducer mirrored.
function snapshotTalkToTalk(snapshotTalk: TalkSnapshot['talk']): Talk {
  return {
    id: snapshotTalk.id,
    ownerId: snapshotTalk.ownerId,
    title: snapshotTalk.title ?? '',
    orchestrationMode: snapshotTalk.orchestrationMode,
    agents: [],
    status: snapshotTalk.status,
    folderId: snapshotTalk.folderId,
    sortOrder: snapshotTalk.sortOrder,
    version: snapshotTalk.version,
    createdAt: snapshotTalk.createdAt,
    updatedAt: snapshotTalk.updatedAt,
    accessRole: snapshotTalk.accessRole,
  };
}

function snapshotRunsToTalkRuns(snapshotRuns: TalkSnapshot['runs']): TalkRun[] {
  return snapshotRuns.map((row) => ({
    id: row.id,
    threadId: row.threadId,
    responseGroupId: row.responseGroupId,
    sequenceIndex: row.sequenceIndex,
    status: row.status,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    completedAt: row.endedAt,
    triggerMessageId: row.triggerMessageId,
    targetAgentId: row.targetAgentId,
    targetAgentNickname: null,
    errorCode: null,
    errorMessage: null,
    cancelReason: null,
    executorAlias: row.executorAlias,
    executorModel: row.executorModel,
  }));
}

function hasFileTransfer(
  dataTransfer: DataTransfer | null | undefined,
): boolean {
  if (!dataTransfer) return false;
  if (dataTransfer.files.length > 0) return true;

  const { types } = dataTransfer;
  if (!types) return false;

  const domTypes = types as unknown as DOMStringList;
  if (typeof domTypes.contains === 'function') {
    return domTypes.contains('Files');
  }

  return Array.from(types as ArrayLike<string>).includes('Files');
}

function sortThreads(threads: TalkThread[]): TalkThread[] {
  return [...threads].sort((left, right) => {
    if (left.isPinned !== right.isPinned) {
      return Number(right.isPinned) - Number(left.isPinned);
    }
    const leftAt = left.lastMessageAt || left.createdAt;
    const rightAt = right.lastMessageAt || right.createdAt;
    const delta = Date.parse(rightAt) - Date.parse(leftAt);
    if (Number.isFinite(delta) && delta !== 0) return delta;
    return rightAt.localeCompare(leftAt);
  });
}

function getConfiguredProviders(
  data: AiAgentsPageData | null,
): AgentProviderCard[] {
  if (!data) return [];
  // Any credential surface the execution-resolver will accept: personal
  // or workspace api_key, personal or workspace OAuth subscription. The
  // ChatGPT Codex provider is subscription_only — gating on
  // hasCredential alone would hide it after a user connected ChatGPT.
  return data.additionalProviders.filter(
    (provider) =>
      provider.hasCredential ||
      provider.workspaceHasCredential ||
      provider.hasPersonalSubscription ||
      provider.hasWorkspaceSubscription,
  );
}

function buildTalkAgentSourceOptions(input: {
  providers: AgentProviderCard[];
}): TalkAgentSourceOption[] {
  return [
    {
      id: 'claude_default',
      label: 'Claude',
      sourceKind: 'claude_default',
      providerId: null,
    },
    ...input.providers.map((provider) => ({
      id: provider.id,
      label: provider.name,
      sourceKind: 'provider' as const,
      providerId: provider.id,
    })),
  ];
}

function getModelSuggestionsForSource(input: {
  sourceKind: 'claude_default' | 'provider';
  providerId: string | null;
  aiAgents: AiAgentsPageData | null;
}): Array<{
  modelId: string;
  displayName: string;
  supportsVision: boolean;
}> {
  if (!input.aiAgents) return [];
  if (input.sourceKind === 'claude_default') {
    return input.aiAgents.claudeModelSuggestions.map((model) => ({
      modelId: model.modelId,
      displayName: model.displayName,
      supportsVision: model.supportsVision === true,
    }));
  }

  const provider = input.aiAgents.additionalProviders.find(
    (entry) => entry.id === input.providerId,
  );
  return (provider?.modelSuggestions || []).map((model) => ({
    modelId: model.modelId,
    displayName: model.displayName,
    supportsVision: model.supportsVision === true,
  }));
}

function talkAgentSupportsVision(
  agent: Pick<TalkAgent, 'sourceKind' | 'providerId' | 'modelId'>,
  registeredAgent:
    | Pick<RegisteredAgent, 'providerId' | 'modelId' | 'supportsVision'>
    | undefined,
  aiAgents: AiAgentsPageData | null,
): boolean {
  // Main slot (modelId=null on the TalkAgent row): trust the registered
  // agent's supportsVision, which is the backend's ground truth from
  // resolveModelCapabilities. Avoids the modelSuggestions lookup, which
  // can miss for subscription providers whose curated rows aren't
  // materialized as suggestions (e.g. Codex's gpt-5.4).
  if (!agent.modelId?.trim()) {
    return registeredAgent?.supportsVision === true;
  }

  if (!aiAgents) return false;

  // Provider-pinned agents (TalkAgent row has its own modelId): look up
  // vision capability via the provider's modelSuggestions. Fall back to
  // the registered agent's supportsVision when the suggestion list misses.
  const provider = aiAgents.additionalProviders.find(
    (entry) => entry.id === agent.providerId,
  );
  if (provider) {
    const model = provider.modelSuggestions.find(
      (entry) => entry.modelId === agent.modelId,
    );
    if (model) return model.supportsVision === true;
  }
  if (agent.providerId === 'provider.anthropic') {
    const claudeModel = aiAgents.claudeModelSuggestions.find(
      (entry) => entry.modelId === agent.modelId,
    );
    if (claudeModel) return claudeModel.supportsVision === true;
  }
  return registeredAgent?.supportsVision === true;
}

function buildAutoNicknameBase(input: {
  sourceKind: 'claude_default' | 'provider';
  providerId: string | null;
  modelId: string | null;
  modelDisplayName?: string | null;
  aiAgents: AiAgentsPageData | null;
}): string {
  if (input.modelDisplayName?.trim()) return input.modelDisplayName.trim();
  const suggestions = getModelSuggestionsForSource({
    sourceKind: input.sourceKind,
    providerId: input.providerId,
    aiAgents: input.aiAgents,
  });
  const found = suggestions.find((entry) => entry.modelId === input.modelId);
  if (found?.displayName) return found.displayName;
  if (input.modelId?.trim()) return input.modelId.trim();
  return input.sourceKind === 'claude_default' ? 'Claude' : 'Provider';
}

function buildUniqueNickname(
  base: string,
  agents: TalkAgent[],
  excludeId?: string,
): string {
  const used = new Set(
    agents
      .filter((agent) => agent.id !== excludeId)
      .map((agent) => agent.nickname.trim())
      .filter(Boolean),
  );
  if (!used.has(base)) return base;
  let index = 2;
  while (used.has(`${base} ${index}`)) {
    index += 1;
  }
  return `${base} ${index}`;
}

function applySourceModelSelection(
  agent: TalkAgent,
  input: {
    sourceKind: 'claude_default' | 'provider';
    providerId: string | null;
    modelId: string;
  },
  allAgents: TalkAgent[],
  aiAgents: AiAgentsPageData | null,
): TalkAgent {
  const suggestions = getModelSuggestionsForSource({
    sourceKind: input.sourceKind,
    providerId: input.providerId,
    aiAgents,
  });
  const selectedModel =
    suggestions.find((entry) => entry.modelId === input.modelId) ||
    suggestions[0] ||
    null;
  const modelId = selectedModel?.modelId || input.modelId || null;
  const modelDisplayName = selectedModel?.displayName || input.modelId || null;
  const nickname =
    agent.nicknameMode === 'custom'
      ? agent.nickname
      : buildUniqueNickname(
          buildAutoNicknameBase({
            sourceKind: input.sourceKind,
            providerId: input.providerId,
            modelId,
            modelDisplayName,
            aiAgents,
          }),
          allAgents,
          agent.id,
        );
  return {
    ...agent,
    sourceKind: input.sourceKind,
    providerId: input.sourceKind === 'provider' ? input.providerId : null,
    modelId,
    modelDisplayName,
    nickname,
  };
}

function buildNewAgentDraft(
  _aiAgents: AiAgentsPageData | null,
): AgentCreationDraft {
  // modelId is overloaded to store the selected registered agent ID.
  // Start empty so the dropdown shows the "Choose a registered agent…" placeholder
  // and the Add button is disabled until the user selects one.
  return {
    sourceKind: 'provider',
    providerId: null,
    modelId: '',
    role: 'assistant',
  };
}

function buildTargetSelection(
  agents: TalkAgent[],
  current: string[],
): string[] {
  const valid = current.filter((id) => agents.some((agent) => agent.id === id));
  if (valid.length > 0) return valid;
  const primary = agents.find((agent) => agent.isPrimary);
  return primary ? [primary.id] : agents[0] ? [agents[0].id] : [];
}

function summarizeAgentLabels(labels: string[]): string {
  if (labels.length === 0) return 'One or more selected agents';
  if (labels.length === 1) return labels[0]!;
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  return `${labels.slice(0, -1).join(', ')}, and ${labels.at(-1)}`;
}

function buildTalkAgentExecutionGuardrail(
  agent: TalkAgent,
  registeredAgent: RegisteredAgent | undefined,
): TalkAgentExecutionGuardrail {
  if (!registeredAgent) {
    return {
      kind: 'direct_safe',
      badgeLabel: null,
      message: null,
    };
  }

  const preview = registeredAgent.executionPreview;
  if (!preview.ready) {
    return {
      kind: 'unavailable',
      badgeLabel: 'Unavailable',
      message: preview.message,
    };
  }

  return {
    kind: 'direct_safe',
    badgeLabel: null,
    message: null,
  };
}

function serializeTalkAgentForDraftCompare(agent: TalkAgent): string {
  return JSON.stringify({
    id: agent.id,
    nickname: agent.nickname,
    nicknameMode: agent.nicknameMode,
    sourceKind: agent.sourceKind,
    providerId: agent.providerId,
    modelId: agent.modelId,
    modelDisplayName: agent.modelDisplayName,
    role: agent.role,
    isPrimary: agent.isPrimary,
    displayOrder: agent.displayOrder,
  });
}

function haveSameTalkAgentDraftState(
  left: TalkAgent[],
  right: TalkAgent[],
): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (
      serializeTalkAgentForDraftCompare(left[index]) !==
      serializeTalkAgentForDraftCompare(right[index])
    ) {
      return false;
    }
  }
  return true;
}

export function TalkDetailPage({
  userId,
  onUnauthorized,
  titleOverride,
  renameDraft,
  onRenameDraftChange,
  onRenameDraftCancel,
  onRenameDraftCommit,
  onSidebarChanged,
  sidebarContents,
}: {
  userId: string;
  onUnauthorized: () => void;
  titleOverride?: string | null;
  renameDraft: { talkId: string; draft: string } | null;
  onRenameDraftChange: (talkId: string, draft: string) => void;
  onRenameDraftCancel: (talkId: string) => void;
  onRenameDraftCommit: (talkId: string, draft: string) => Promise<void>;
  onSidebarChanged: () => Promise<void> | void;
  sidebarContents: ContentSidebarItem[];
}): JSX.Element {
  const { talkId = '' } = useParams<{ talkId: string }>();
  const navigate = useNavigate();
  const { currentTab, locationParams } = useTalkDetailRouteState(talkId);
  const requestedThreadId = locationParams.get('thread')?.trim() || null;
  // If the URL hasn't pinned a thread yet, ride the saved last-viewed
  // thread for this Talk so the snapshot warms straight to the UX the
  // user expects (avoids the bootstrap → refetch-on-resolve double-hop).
  const initialResolvedThreadId =
    requestedThreadId ?? getLastThreadForTalk(talkId);
  const queryClient = useQueryClient();
  const snapshotQuery = useTalkSnapshot({
    userId,
    talkId,
    threadId: initialResolvedThreadId,
    onUnauthorized,
  });
  const wsCacheRouterRef = useRef(createWsCacheRouter(queryClient));
  const [state, dispatch] = useReducer(
    detailReducer,
    undefined,
    createInitialDetailState,
  );

  // Derived snapshot accessors — PR C: server data lives in React
  // Query. Render-site reads pull from these instead of the reducer.
  //
  // Once the page has rendered with snapshot data, we stay 'ready' even
  // during background refetches and thread-switch rekeys (which drop
  // snapshotQuery.data back to undefined). Flipping pageKind back to
  // 'loading' would unmount the ready-branch tree — replacing the
  // thread rail / composer DOM nodes — which breaks any handler that
  // captured a DOM reference (e.g. handleDeleteThread holding a
  // threadRail node) and causes a visible page-level loading flash.
  const lastSnapshotRef = useRef<TalkSnapshot | null>(null);
  // Only fall back to the last-good snapshot when it belongs to the
  // currently-routed talk. Cross-talk navigation drops the fallback
  // immediately so the previous talk's messages/title can't render
  // against the new talkId — and so handlers reading pageTalk.id can't
  // mutate the previous Talk before the new snapshot resolves.
  if (snapshotQuery.data) {
    lastSnapshotRef.current = snapshotQuery.data;
  } else if (
    lastSnapshotRef.current &&
    lastSnapshotRef.current.talk.id !== talkId
  ) {
    lastSnapshotRef.current = null;
  }
  const talkSnapshot = snapshotQuery.data ?? lastSnapshotRef.current;
  const snapshotError = snapshotQuery.error;
  const snapshotIs404 =
    snapshotError instanceof ApiError && snapshotError.status === 404;
  const pageKind: 'loading' | 'ready' | 'unavailable' | 'error' = snapshotIs404
    ? 'unavailable'
    : snapshotError
      ? 'error'
      : !talkSnapshot
        ? 'loading'
        : 'ready';
  const pageErrorMessage: string | null = snapshotIs404
    ? 'Talk not found'
    : snapshotError instanceof Error
      ? snapshotError.message
      : null;
  const pageTalk: Talk | null = useMemo(
    () => (talkSnapshot ? snapshotTalkToTalk(talkSnapshot.talk) : null),
    [talkSnapshot?.talk],
  );
  const activeTalkWorkspaceId = talkSnapshot?.talk.workspaceId ?? null;

  const [threadState, setThreadState] = useState<ThreadListState>({
    threads: [],
    loading: true,
    error: null,
  });
  const [editingThreadId, setEditingThreadId] = useState<string | null>(null);
  const [threadMenu, setThreadMenu] = useState<{
    threadId: string;
    x: number;
    y: number;
  } | null>(null);
  const [runContextPanels, setRunContextPanels] = useState<
    Record<string, RunContextPanelState>
  >({});
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<TalkMessageSearchResult[]>(
    [],
  );
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [retryRunState, setRetryRunState] = useState<{
    runId: string;
    status: 'posting' | 'error';
    message: string;
  } | null>(null);
  const [pendingAttachments, setPendingAttachments] = useState<
    Array<{
      localId: string;
      file: File;
      fileName: string;
      fileSize: number;
      mimeType: string;
      isImage: boolean;
      previewUrl?: string;
      status: 'uploading' | 'ready' | 'error';
      attachmentId?: string;
      errorMessage?: string;
    }>
  >([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const pendingAttachmentsRef = useRef(pendingAttachments);
  const runContextPanelsRef = useRef<Record<string, RunContextPanelState>>({});
  const threadRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const threadRefreshInFlightRef = useRef(false);
  const threadRefreshDirtyRef = useRef(false);
  const pendingComposerFocusRef = useRef(false);
  const pendingRunHistoryScrollRef = useRef<string | null>(null);
  const activeThreadIdRef = useRef<string | null>(null);
  // Talk id for which `threadState.threads` was last loaded. Gates the
  // routing-resolution effect so it can't run with a freshly-changed
  // talkId but stale threadState (same-commit cross-talk navigation).
  const threadStateTalkIdRef = useRef<string | null>(null);
  const threadSnapshotVersionRef = useRef(0);
  const deletedMessageIdsRef = useRef<Set<string>>(new Set());
  // Bumped whenever deleted ids are recorded so memoized message lists
  // re-run the deleted-id filter even if the messages array itself is
  // unchanged (a stale resync can return the pre-delete list verbatim).
  const [deletedIdsVersion, setDeletedIdsVersion] = useState(0);
  // Tracks every runId we've ever seen on MESSAGE_APPENDED. Used by the
  // "missing persisted message" timer below to decide whether to refetch.
  const persistedRunMessageIdsRef = useRef<Set<string>>(new Set());
  // Timer per runId that fires if RUN_COMPLETED arrives but the matching
  // MESSAGE_APPENDED never lands. Without this, a dropped persistence event
  // leaves the timeline empty until the user reloads or switches threads.
  const pendingMessageRefetchTimersRef = useRef<
    Map<string, ReturnType<typeof setTimeout>>
  >(new Map());
  const threadStateRef = useRef<ThreadListState>(threadState);
  const searchQueryRef = useRef(searchQuery);
  const orchestrationMenuRef = useRef<HTMLDivElement | null>(null);
  const [loadingOlderMessages, setLoadingOlderMessages] = useState(false);
  // Tracks whether the server has more history past the current view.
  // Initial value follows snapshot.hasOlderMessages; flips to false the
  // moment a `?before=<oldest>` page comes back short, so the
  // Load-earlier button hides once history is exhausted.
  const [olderMessagesAvailable, setOlderMessagesAvailable] = useState(false);
  // Bumped each time a `talk_tools_changed` event arrives. Triggers
  // ToolChipsBar to refetch its active set so chip state syncs across
  // tabs without us threading the payload through.
  const [toolsRefreshKey, setToolsRefreshKey] = useState(0);
  // Composer `@`-mention typeahead. Tracks the live `@` index in the
  // draft and the active picker selection. Opens when @ lands at a word
  // boundary AND the Talk has an attached doc OR at least one ready
  // saved source. The popover offers `@doc` (if applicable) plus every
  // ready source filtered by the chars typed after `@`.
  const [mentionState, setMentionState] = useState<{
    atIndex: number;
    selectedIndex: number;
  } | null>(null);
  const [agents, setAgents] = useState<TalkAgent[]>([]);
  const [agentDrafts, setAgentDrafts] = useState<TalkAgent[]>([]);
  const [aiAgentsData, setAiAgentsData] = useState<AiAgentsPageData | null>(
    null,
  );
  const [registeredAgentsCatalog, setRegisteredAgentsCatalog] = useState<
    RegisteredAgent[]
  >([]);
  const [agentsCatalogError, setAgentsCatalogError] = useState<string | null>(
    null,
  );
  const [targetAgentIds, setTargetAgentIds] = useState<string[]>([]);
  const [newAgentDraft, setNewAgentDraft] = useState<AgentCreationDraft>({
    sourceKind: 'claude_default',
    providerId: null,
    modelId: '',
    role: 'assistant',
  });
  const [agentState, setAgentState] = useState<{
    status: 'idle' | 'saving' | 'error' | 'success';
    message?: string;
  }>({ status: 'idle' });
  const [historyEditorOpen, setHistoryEditorOpen] = useState(false);
  const [historyEditState, setHistoryEditState] = useState<{
    status: 'idle' | 'saving' | 'error' | 'success';
    message?: string;
  }>({ status: 'idle' });
  const [orchestrationState, setOrchestrationState] = useState<{
    status: 'idle' | 'saving' | 'error';
    message?: string;
  }>({ status: 'idle' });
  const [orchestrationMenuOpen, setOrchestrationMenuOpen] = useState(false);

  const titleInputRef = useRef<HTMLInputElement | null>(null);
  const messageElementRefs = useRef<Map<string, HTMLElement>>(new Map());
  const autoStickToBottomRef = useRef<ScrollBehavior | null>(null);
  // Whether the user is currently following the bottom of the timeline.
  // Driven by the scroll-restore decision + every user scroll; consulted by
  // the bottom-stick ResizeObserver so growth only re-pins when at the bottom.
  const followBottomRef = useRef(true);
  const onUnauthorizedRef = useRef(onUnauthorized);

  useEffect(() => {
    onUnauthorizedRef.current = onUnauthorized;
  }, [onUnauthorized]);

  activeThreadIdRef.current = activeThreadId;
  threadStateRef.current = threadState;
  searchQueryRef.current = searchQuery;
  runContextPanelsRef.current = runContextPanels;

  useEffect(() => {
    threadSnapshotVersionRef.current += 1;
  }, [activeThreadId]);

  // PR C: keep the reducer's selectedThreadId in lockstep with the
  // page's activeThreadId useState. Several actions (RUN_QUEUED,
  // RUN_STARTED, RESPONSE_FAILED) guard on this to decide whether a
  // live-response panel belongs in the currently-rendered thread.
  useEffect(() => {
    dispatch({ type: 'THREAD_SELECTED', threadId: activeThreadId });
  }, [activeThreadId]);

  const currentThreadHasContent = useMemo(
    () =>
      activeThreadId !== null &&
      sidebarContents.some((c) => c.threadId === activeThreadId),
    [activeThreadId, sidebarContents],
  );

  const {
    docModalOpen,
    docModalTitle,
    setDocModalTitle,
    docModalFormat,
    setDocModalFormat,
    docModalSubmitting,
    docModalError,
    docModalInputRef,
    openDocModal,
    closeDocModal,
    handleCreateDoc,
    talkContent,
    setTalkContent,
    talkContentLoading,
    talkContentError,
    setTalkContentError,
    talkContentPendingEdits,
    setTalkContentPendingEdits,
    pendingEditStreamingByRunId,
    setPendingEditStreamingByRunId,
    pendingEditStreamingStartedAtRef,
    pendingEditInFlight,
    setPendingEditInFlight,
    talkContentSaveStatus,
    setTalkContentSaveStatus,
    talkContentConflict,
    setTalkContentConflict,
    talkContentRef,
    talkContentSaveStatusRef,
    docPaneHidden,
    setDocPaneHidden,
    htmlMode,
    setHtmlMode,
    htmlAutoFlippedRef,
    htmlSourceDraft,
    docBodyRef,
    docNarrowShowBtnRef,
    chatRatio,
    isNarrowViewport,
    mobilePane,
    setMobilePane,
    splitContainerRef,
    splitHandleRef,
    handleResizeHandleKeyDown,
    handleHtmlSourceChange,
    handleHtmlSourceSave,
    handleDocTitleSave,
    handleHideDocPane,
    handleShowDocPane,
    refetchTalkContent,
    hydrateDocumentFromSnapshot,
  } = useTalkDocumentController({
    talkId,
    userId,
    activeThreadId,
    activeThreadIdRef,
    currentTab,
    locationParams,
    currentThreadHasContent,
    queryClient,
    navigate,
    onUnauthorized,
    onSidebarChanged,
  });

  const isNearBottom = useCallback((): boolean => {
    const container = timelineRef.current;
    if (!container) return true;
    const distanceToBottom =
      container.scrollHeight - (container.scrollTop + container.clientHeight);
    return distanceToBottom <= SCROLL_STICK_THRESHOLD_PX;
  }, []);

  const scrollToBottom = useCallback(
    (behavior: ScrollBehavior = 'auto', shouldStillScroll?: () => boolean) => {
      // Drive timelineRef.scrollTop directly instead of
      // endRef.scrollIntoView. The latter walks every overflow-scrollable
      // ancestor and the talk shell has two of them (.talk-workspace-scroll
      // wraps .talk-thread-scroll). In nested scroll containers,
      // scrollIntoView can end up scrolling the outer wrapper to put endRef
      // at the bottom of the viewport — which visually leaves the inner
      // scroll at the top showing the oldest messages. Targeting the inner
      // container alone is unambiguous. requestAnimationFrame defers the
      // write to the next frame so scrollHeight reflects the newly
      // committed message.
      if (import.meta.env.DEV && typeof window !== 'undefined') {
        const w = window as unknown as {
          __clawtalkScrollToBottomCount?: number;
        };
        w.__clawtalkScrollToBottomCount =
          (w.__clawtalkScrollToBottomCount ?? 0) + 1;
      }
      const apply = () => {
        // Deferred to the next frame, so re-check at write time: a caller (the
        // streaming auto-stick) may pass a guard that turns false if the user
        // scrolled away before this ran, and we must not yank them back.
        if (shouldStillScroll && !shouldStillScroll()) return;
        const container = timelineRef.current;
        if (!container) return;
        const target = container.scrollHeight - container.clientHeight;
        if (target <= 0) return;
        if (behavior === 'smooth' && typeof container.scrollTo === 'function') {
          container.scrollTo({ top: target, behavior: 'smooth' });
        } else {
          container.scrollTop = target;
        }
      };
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(apply);
      } else {
        apply();
      }
    },
    [],
  );

  const setMessageElementRef = useCallback(
    (messageId: string, element: HTMLElement | null) => {
      if (element) {
        messageElementRefs.current.set(messageId, element);
        return;
      }
      messageElementRefs.current.delete(messageId);
    },
    [],
  );

  const handleUnauthorized = useCallback(() => {
    onUnauthorizedRef.current();
  }, []);

  const {
    activeRuleCount,
    contextGoal,
    setContextGoal,
    contextRules,
    setContextRules,
    contextSources,
    setContextSources,
    contextStatus,
    setContextStatus,
    goalDraft,
    setGoalDraft,
    newRuleText,
    setNewRuleText,
    ruleDrafts,
    setRuleDrafts,
  } = useTalkContextController({
    talkId,
    currentTab,
    pageKind,
    onUnauthorized: handleUnauthorized,
  });

  const refreshThreadListNow = useCallback(async () => {
    if (threadRefreshInFlightRef.current) {
      threadRefreshDirtyRef.current = true;
      return;
    }
    threadRefreshInFlightRef.current = true;
    try {
      const next = sortThreads(await listTalkThreads(talkId));
      setThreadState({ threads: next, loading: false, error: null });
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        handleUnauthorized();
        return;
      }
      setThreadState((current) => ({
        ...current,
        loading: false,
        error: err instanceof Error ? err.message : 'Failed to load threads.',
      }));
    } finally {
      threadRefreshInFlightRef.current = false;
      if (threadRefreshDirtyRef.current) {
        threadRefreshDirtyRef.current = false;
        void refreshThreadListNow();
      }
    }
  }, [handleUnauthorized, talkId]);

  const rememberDeletedMessageIds = useCallback((messageIds: string[]) => {
    if (messageIds.length === 0) return;
    const next = new Set(deletedMessageIdsRef.current);
    for (const messageId of messageIds) {
      const normalized = messageId.trim();
      if (normalized) {
        next.add(normalized);
      }
    }
    deletedMessageIdsRef.current = next;
    // Re-run memoized message filters even if the messages array doesn't
    // change — otherwise a racing execution resync that returns the
    // pre-delete rows verbatim would flash the just-deleted messages back.
    setDeletedIdsVersion((v) => v + 1);
  }, []);

  const filterDeletedMessages = useCallback((messages: TalkMessage[]) => {
    if (deletedMessageIdsRef.current.size === 0) return messages;
    return messages.filter(
      (message) => !deletedMessageIdsRef.current.has(message.id),
    );
  }, []);

  // PR C: cached message timeline derived from the snapshot. The wsCacheRouter
  // appends new messages via setQueryData; this memo re-derives whenever the
  // identity of `talkSnapshot.messages` changes (mutation, refetch, delete).
  const pageMessages: TalkMessage[] = useMemo(
    () => filterDeletedMessages(talkSnapshot?.messages ?? EMPTY_MESSAGES),
    [deletedIdsVersion, filterDeletedMessages, talkSnapshot?.messages],
  );
  const pageMessageIds = useMemo(
    () => new Set(pageMessages.map((m) => m.id)),
    [pageMessages],
  );

  const handleLoadOlderMessages = useCallback(async (): Promise<void> => {
    const threadId = activeThreadIdRef.current;
    if (!threadId) return;
    if (loadingOlderMessages) return;
    const oldest = pageKind === 'ready' ? pageMessages[0] : null;
    if (!oldest) return;
    setLoadingOlderMessages(true);
    const pageSize = 200;
    try {
      const older = await listTalkMessages(talkId, {
        threadId,
        before: oldest.createdAt,
        limit: pageSize,
      });
      if (activeThreadIdRef.current !== threadId) return;
      const filtered = filterDeletedMessages(older);
      // Server returned fewer than we asked for → no more history. Patch
      // the snapshot's `hasOlderMessages` in the same setQueryData so a
      // background refetch can't mirror the stale `true` back into the
      // page state (Codex #466 P2 + Codex #462 P3).
      const isFinalPage = older.length < pageSize;
      prependOlderTalkMessagesToSnapshot({
        queryClient,
        userId,
        talkId,
        threadId,
        messages: filtered,
        hasOlderMessages: isFinalPage ? false : undefined,
      });
      if (isFinalPage) {
        setOlderMessagesAvailable(false);
      }
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        handleUnauthorized();
      }
    } finally {
      setLoadingOlderMessages(false);
    }
  }, [
    filterDeletedMessages,
    handleUnauthorized,
    loadingOlderMessages,
    pageKind,
    pageMessages,
    queryClient,
    talkId,
    userId,
  ]);

  const scheduleThreadListRefresh = useCallback(() => {
    threadRefreshDirtyRef.current = true;
    if (threadRefreshTimerRef.current) return;
    threadRefreshTimerRef.current = setTimeout(() => {
      threadRefreshTimerRef.current = null;
      if (!threadRefreshDirtyRef.current) return;
      threadRefreshDirtyRef.current = false;
      void refreshThreadListNow();
    }, 500);
  }, [refreshThreadListNow]);

  const resyncTalkState = useCallback(
    async (options?: { refreshThreads?: boolean }) => {
      const threadId = activeThreadIdRef.current;
      if (!threadId) return;
      const snapshotVersion = threadSnapshotVersionRef.current;
      // PR C: messages + active runs come from the snapshot query —
      // invalidate it and let RQ refetch. Historical runs are still
      // separate; re-fetch them in parallel so the Runs tab updates.
      // The threads list stays on its component-local state.
      void queryClient.invalidateQueries({
        queryKey: snapshotQueryKey(userId, talkId, threadId),
      });
      try {
        const [threads, runs] = await Promise.all([
          options?.refreshThreads === false
            ? Promise.resolve(null)
            : listTalkThreads(talkId),
          getTalkRuns(talkId),
        ]);
        if (
          threadId !== activeThreadIdRef.current ||
          snapshotVersion !== threadSnapshotVersionRef.current
        ) {
          return;
        }
        if (threads) {
          setThreadState({
            threads: sortThreads(threads),
            loading: false,
            error: null,
          });
        }
        dispatch({ type: 'MERGE_HISTORICAL_RUNS', runs });
        autoStickToBottomRef.current = 'smooth';
      } catch (err) {
        if (err instanceof UnauthorizedError) {
          handleUnauthorized();
        }
      }
    },
    [handleUnauthorized, queryClient, talkId, userId],
  );

  const refreshBrowserRuns = useCallback(
    async () => resyncTalkState({ refreshThreads: true }),
    [resyncTalkState],
  );

  const {
    talkJobs,
    setTalkJobs,
    talkJobsLoaded,
    setTalkJobsLoaded,
    talkJobsStatus,
    setTalkJobsStatus,
    selectedJobId,
    setSelectedJobId,
    creatingJob,
    setCreatingJob,
    jobDraft,
    setJobDraft,
    selectedJobRuns,
    setSelectedJobRuns,
    selectedJobRunsStatus,
    setSelectedJobRunsStatus,
    handleJobRunSettled,
  } = useTalkJobsController({
    talkId,
    activeThreadIdRef,
    resyncTalkState,
  });

  // Tracks the last (talkId, activeThreadId) we fully hydrated from the
  // snapshot. PR C: same-thread refetches no longer dispatch into the
  // reducer at all — the snapshot owns messages/talk/content — but we
  // still gate the run-side SNAPSHOT_HYDRATED so we don't re-seed active
  // runs on every background refetch.
  const hydratedKeyRef = useRef<string | null>(null);

  // Reset every per-talk slice when talkId changes. The snapshot query
  // and the runs/agents fetch below re-hydrate them; the rest stay at
  // their defaults until the user opens the corresponding tab.
  useEffect(() => {
    dispatch({ type: 'TALK_RESET' });
    threadStateTalkIdRef.current = null;
    hydratedKeyRef.current = null;
    lastSnapshotRef.current = null;
    messageElementRefs.current.clear();
    setThreadState({ threads: [], loading: true, error: null });
    deletedMessageIdsRef.current = new Set();
    setActiveThreadId(null);
    setSearchQuery('');
    setSearchResults([]);
    setSearchLoading(false);
    setSearchError(null);
    setAgents([]);
    setAgentDrafts([]);
    setTargetAgentIds([]);
    setAgentsCatalogError(null);
    setAgentState({ status: 'idle' });
    setHistoryEditorOpen(false);
    setHistoryEditState({ status: 'idle' });
    setOrchestrationState({ status: 'idle' });
    setRunContextPanels({});
    return () => {
      if (threadRefreshTimerRef.current) {
        clearTimeout(threadRefreshTimerRef.current);
        threadRefreshTimerRef.current = null;
      }
    };
  }, [talkId]);

  // Hydrate non-RQ side-effects the moment the snapshot resolves: the
  // thread list (kept in component state because the threads tab edits
  // it independently), the doc panel useState bridges (kept until a
  // future PR migrates them to RQ), and the reducer's runs slice via
  // SNAPSHOT_HYDRATED. Same-thread refetches re-run only the bridges,
  // never the reducer dispatch, so an inbound `setQueryData` patch
  // doesn't clobber live-streaming state.
  useEffect(() => {
    if (snapshotQuery.error) return;
    const snapshot = snapshotQuery.data;
    if (!snapshot) return;
    if (snapshot.talk.id !== talkId) return;
    const hydrationKey = `${talkId}::${snapshot.activeThreadId}`;
    const isFirstHydration = hydratedKeyRef.current !== hydrationKey;
    const sortedThreads = sortThreads(
      snapshot.threads.filter((thread) => !thread.isInternal),
    );
    setThreadState({ threads: sortedThreads, loading: false, error: null });
    threadStateTalkIdRef.current = talkId;
    // Always reconcile doc state — it advances independently of the
    // message timeline (content_updated/applied/resolved invalidates).
    hydrateDocumentFromSnapshot(snapshot);
    rememberActiveThreadForTalk(talkId, snapshot.activeThreadId);
    setOlderMessagesAvailable(snapshot.hasOlderMessages);
    if (!isFirstHydration) return;
    hydratedKeyRef.current = hydrationKey;
    dispatch({
      type: 'SNAPSHOT_HYDRATED',
      threadId: snapshot.activeThreadId,
      runs: snapshotRunsToTalkRuns(snapshot.runs),
    });
  }, [
    hydrateDocumentFromSnapshot,
    snapshotQuery.data,
    snapshotQuery.error,
    talkId,
  ]);

  // Rich runs (historical) + rich agents (provider/model/health) come
  // from these two existing endpoints — kept out of the snapshot wire
  // shape to keep that payload tight. Fire in parallel with the
  // snapshot so they don't gate the first paint. PR C: both ordering
  // cases (parallel-first or snapshot-first) merge cleanly because
  // SNAPSHOT_HYDRATED and MERGE_HISTORICAL_RUNS are both pure overlays
  // on `runsById` that preserve any live-state already accumulated.
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const [runs, talkAgents] = await Promise.all([
          getTalkRuns(talkId),
          getTalkAgents(talkId),
        ]);
        if (cancelled) return;
        setAgents(talkAgents);
        setAgentDrafts(talkAgents);
        setTargetAgentIds(buildTargetSelection(talkAgents, []));
        // MERGE_HISTORICAL_RUNS is a pure overlay — order-independent
        // vs the snapshot effect's SNAPSHOT_HYDRATED, since neither
        // clobbers in-flight live state on existing run ids.
        dispatch({ type: 'MERGE_HISTORICAL_RUNS', runs });
      } catch (err) {
        if (err instanceof UnauthorizedError) {
          handleUnauthorized();
        }
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [handleUnauthorized, talkId]);

  useEffect(() => {
    if (threadState.loading) return;
    // Bail when threadState was loaded for a different talkId — happens
    // mid-commit during cross-talk sidebar navigation, where this effect
    // fires before the bootstrap effect's state resets propagate.
    // Without this gate we'd save Talk A's threads[0] under Talk B's key.
    if (threadStateTalkIdRef.current !== talkId) return;
    if (threadState.threads.length === 0) {
      setActiveThreadId(null);
      return;
    }
    // Resolution order: URL ?thread= → saved-last-thread for this Talk
    // (localStorage) → most-recent-by-activity (threads[0]). Saved id is
    // dropped if the thread no longer exists.
    let validThreadId: string | null = null;
    if (
      requestedThreadId &&
      threadState.threads.some((thread) => thread.id === requestedThreadId)
    ) {
      validThreadId = requestedThreadId;
    } else {
      const saved = getLastThreadForTalk(talkId);
      if (saved && threadState.threads.some((thread) => thread.id === saved)) {
        validThreadId = saved;
      } else {
        validThreadId = threadState.threads[0]?.id || null;
      }
    }
    if (!validThreadId) return;
    if (requestedThreadId !== validThreadId) {
      navigate(buildThreadHref(talkId, validThreadId, currentTab), {
        replace: true,
      });
    }
    if (activeThreadId !== validThreadId) {
      setActiveThreadId(validThreadId);
    }
    // Persist the (talkId, threadId) pairing here — this is the only
    // place we know threadState has been loaded for the CURRENT talkId,
    // so a sidebar click to another Talk can't race a stale activeThreadId
    // into the wrong key.
    setLastThreadForTalk(talkId, validThreadId);
  }, [
    activeThreadId,
    currentTab,
    navigate,
    requestedThreadId,
    talkId,
    threadState.loading,
    threadState.threads,
  ]);

  useEffect(() => {
    setSearchResults([]);
    setSearchError(null);
    setRetryRunState(null);
  }, [activeThreadId]);

  // Thread-show scroll: restore the saved offset for this (talkId,
  // threadId) if the user had scrolled up to read history; otherwise
  // park at the bottom.
  //
  // We gate on the snapshot's activeThreadId matching the current
  // activeThreadId so a thread switch waits for the new snapshot to
  // land before scrolling — pageKind stays 'ready' across switches via
  // lastSnapshotRef, so the previous thread's DOM is what's mounted
  // until the new snapshot resolves. snapshotActiveThreadId is a
  // primitive derived from the cached snapshot, so background refetches
  // for the same thread don't re-trigger this effect.
  const snapshotActiveThreadId = snapshotQuery.data?.activeThreadId ?? null;
  useEffect(() => {
    if (pageKind !== 'ready' || !activeThreadId) return;
    if (snapshotActiveThreadId !== activeThreadId) return;
    const saved = loadThreadScroll(talkId, activeThreadId);
    const rafId = requestAnimationFrame(() => {
      if (pendingComposerFocusRef.current) {
        pendingComposerFocusRef.current = false;
        textareaRef.current?.focus();
      }
      if (saved && !saved.atBottom) {
        const container = timelineRef.current;
        if (container) {
          const maxOffset = Math.max(
            0,
            container.scrollHeight - container.clientHeight,
          );
          container.scrollTop = Math.min(saved.offset, maxOffset);
        }
        followBottomRef.current = false;
      } else {
        scrollToBottom('auto');
        followBottomRef.current = true;
      }
      dispatch({ type: 'CLEAR_UNREAD' });
    });
    // StrictMode in dev runs the mount effect twice; cancelling the
    // first rAF on cleanup ensures the second setup wins and we don't
    // scroll twice on warm-cache mounts where the gate passes on the
    // very first render.
    return () => cancelAnimationFrame(rafId);
  }, [
    activeThreadId,
    scrollToBottom,
    pageKind,
    snapshotActiveThreadId,
    talkId,
  ]);

  // Persist scroll position + at-bottom flag on user scroll, debounced
  // ~200ms. Owns the localStorage write end of the per-thread scroll
  // memory so the next mount can restore.
  useEffect(() => {
    const container = timelineRef.current;
    if (!container) return;
    if (pageKind !== 'ready' || !activeThreadId) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const capturedTalkId = talkId;
    const capturedThreadId = activeThreadId;
    const onScroll = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        const el = timelineRef.current;
        if (!el) return;
        saveThreadScroll(capturedTalkId, capturedThreadId, {
          offset: el.scrollTop,
          atBottom: isNearBottom(),
        });
      }, 200);
    };
    container.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      container.removeEventListener('scroll', onScroll);
      if (timer) clearTimeout(timer);
    };
  }, [activeThreadId, isNearBottom, pageKind, talkId]);

  // Reset the follow flag whenever the thread changes: default to "not
  // following" until the per-thread scroll-restore effect above decides. This
  // keeps the reflow stick inert during a cold thread-switch fetch (when the
  // restore effect is gated out waiting on the snapshot), so it can never pin
  // to the bottom over a restored mid-scroll position.
  useEffect(() => {
    followBottomRef.current = false;
  }, [activeThreadId]);

  // Robust bottom-stick through reflow. The per-event stick + scrollToBottom
  // compute their scroll target in a single rAF, so when the timeline grows a
  // frame later — a streamed token, the live→settled markdown swap, a just-
  // sent message — the view lands short of the true bottom. Track whether the
  // user is following the bottom (followBottomRef: set by the restore decision,
  // updated on every user scroll) and, on each content resize, re-pin to the
  // true bottom. The ResizeObserver fires after layout, so scrollHeight is
  // already current and we write scrollTop directly — no deferred rAF that
  // could yank a user who scrolled away in the meantime. We pin only while
  // following (never yanks a reader), skip the first/initial-size callback (so
  // a remount or thread switch can't auto-scroll), and bind to the Talk tab
  // only — the timeline unmounts on other tabs, so the effect must re-bind on
  // tab re-entry (and per thread).
  useEffect(() => {
    if (pageKind !== 'ready' || !activeThreadId || currentTab !== 'talk') {
      return;
    }
    const container = timelineRef.current;
    if (!container) return;
    const onScroll = () => {
      followBottomRef.current = isNearBottom();
    };
    container.addEventListener('scroll', onScroll, { passive: true });
    if (typeof ResizeObserver === 'undefined') {
      return () => container.removeEventListener('scroll', onScroll);
    }
    const content = container.querySelector<HTMLElement>(
      '.talk-thread-timeline',
    );
    let initialized = false;
    const observer = new ResizeObserver(() => {
      if (!initialized) {
        initialized = true;
        return;
      }
      if (!followBottomRef.current) return;
      const el = timelineRef.current;
      if (!el) return;
      const target = el.scrollHeight - el.clientHeight;
      if (target > 0) el.scrollTop = target;
    });
    if (content) observer.observe(content);
    return () => {
      container.removeEventListener('scroll', onScroll);
      observer.disconnect();
    };
  }, [activeThreadId, currentTab, isNearBottom, pageKind]);

  useEffect(() => {
    if (pageKind !== 'ready' || !activeTalkWorkspaceId) {
      setAiAgentsData(null);
      setRegisteredAgentsCatalog([]);
      setAgentsCatalogError(null);
      return;
    }

    let cancelled = false;
    const loadAiAgents = async () => {
      try {
        const [next, regAgents] = await Promise.all([
          getAiAgents({ workspaceId: activeTalkWorkspaceId }),
          listRegisteredAgents({ workspaceId: activeTalkWorkspaceId }),
        ]);
        if (cancelled) return;
        setAiAgentsData(next);
        setRegisteredAgentsCatalog(regAgents);
        setAgentsCatalogError(null);
        setNewAgentDraft((current) =>
          current.modelId ? current : buildNewAgentDraft(next),
        );
      } catch (err) {
        if (err instanceof UnauthorizedError) {
          handleUnauthorized();
          return;
        }
        if (!cancelled) {
          setAiAgentsData(null);
          setRegisteredAgentsCatalog([]);
          setAgentsCatalogError(
            err instanceof Error ? err.message : 'Failed to load AI agents.',
          );
        }
      }
    };

    void loadAiAgents();
    return () => {
      cancelled = true;
    };
  }, [activeTalkWorkspaceId, handleUnauthorized, pageKind]);

  const ensureKnownThread = useCallback(
    (threadId?: string | null): boolean => {
      if (!threadId) return false;
      const known = threadStateRef.current.threads.some(
        (thread) => thread.id === threadId,
      );
      if (!known) {
        scheduleThreadListRefresh();
      }
      return known;
    },
    [scheduleThreadListRefresh],
  );

  const bumpThreadSummaryFromMessage = useCallback(
    (threadId: string, createdAt: string) => {
      const known = threadStateRef.current.threads.some(
        (thread) => thread.id === threadId,
      );
      if (!known) {
        scheduleThreadListRefresh();
        return;
      }
      setThreadState((current) => {
        const threads = current.threads.map((thread) => {
          if (thread.id !== threadId) return thread;
          return {
            ...thread,
            messageCount: thread.messageCount + 1,
            lastMessageAt: createdAt,
          };
        });
        return { ...current, threads: sortThreads(threads) };
      });
    },
    [scheduleThreadListRefresh],
  );

  useTalkRunStream({
    dispatch,
    talkId,
    userId,
    pageKind,
    queryClient,
    handleUnauthorized,
    ensureKnownThread,
    bumpThreadSummaryFromMessage,
    isNearBottom,
    rememberDeletedMessageIds,
    scheduleThreadListRefresh,
    resyncTalkState,
    refetchTalkContent,
    deletedMessageIdsRef,
    persistedRunMessageIdsRef,
    pendingMessageRefetchTimersRef,
    activeThreadIdRef,
    autoStickToBottomRef,
    talkContentRef,
    talkContentSaveStatusRef,
    pendingEditStreamingStartedAtRef,
    htmlAutoFlippedRef,
    wsCacheRouterRef,
    setTalkContentConflict,
    setPendingEditStreamingByRunId,
    setHtmlMode,
    setTalkContentPendingEdits,
    setToolsRefreshKey,
  });

  useEffect(() => {
    if (pageKind !== 'ready') return;
    // autoStickToBottomRef carries the scroll BEHAVIOR, not just a boolean:
    // 'smooth' for one-shot discrete scrolls (user send, history load) and
    // 'auto' (instant) for the streaming follow. Instant matters during
    // streaming — a 'smooth' animation chases a bottom that keeps growing as
    // tokens arrive, so isNearBottom() reads false mid-animation, the stick
    // disarms, and the view lands short of the true bottom.
    const stickBehavior = autoStickToBottomRef.current;
    if (!stickBehavior) return;
    autoStickToBottomRef.current = null;
    // The scroll is deferred a frame, so guard it on the live follow state —
    // the user may scroll up before it runs and must not be yanked back. This
    // applies to BOTH 'auto' (streaming) and 'smooth' (e.g. a non-user
    // resyncTalkState stream-recovery scroll). Genuine user jumps (send,
    // clear-unread) set followBottomRef = true first, so their scroll still
    // goes through.
    scrollToBottom(stickBehavior, () => followBottomRef.current);
    dispatch({ type: 'CLEAR_UNREAD' });
    // Also depends on liveResponsesByRunId so the effect re-runs on
    // RESPONSE_STARTED (placeholder appears) and on each RESPONSE_DELTA
    // (text grows). The talkStream handlers re-set autoStickToBottomRef
    // every event if the user is still near the bottom, so this becomes
    // a continuous "stick" during streaming. If the user scrolls away,
    // nearBottom flips false, the handlers stop setting the ref, and
    // this effect skips the scroll until they scroll back down.
  }, [
    scrollToBottom,
    pageKind,
    pageMessages.length,
    state.liveResponsesByRunId,
  ]);

  const accessRole = pageKind === 'ready' ? pageTalk?.accessRole : null;
  const canEditAgents =
    accessRole === 'owner' || accessRole === 'admin' || accessRole === 'editor';
  const canEditJobs = canEditAgents;
  const canEditDoc = canEditAgents;
  // Pre-built agent options for TalkJobsPanel's target-agent picker (the panel
  // owns neither the roster nor buildAgentLabel).
  const jobAgentOptions = useMemo<JobAgentOption[]>(
    () =>
      agents.map((agent) => ({
        id: agent.id,
        label: buildAgentLabel(agent),
        isPrimary: agent.isPrimary,
      })),
    [agents],
  );

  const canManageTalkConnectors =
    accessRole === 'owner' || accessRole === 'admin';

  const configuredProviders = useMemo(
    () => getConfiguredProviders(aiAgentsData),
    [aiAgentsData],
  );
  const sourceOptions = useMemo(
    () => buildTalkAgentSourceOptions({ providers: configuredProviders }),
    [configuredProviders],
  );
  const newAgentModelOptions = useMemo(
    () =>
      getModelSuggestionsForSource({
        sourceKind: newAgentDraft.sourceKind,
        providerId: newAgentDraft.providerId,
        aiAgents: aiAgentsData,
      }),
    [aiAgentsData, newAgentDraft.providerId, newAgentDraft.sourceKind],
  );
  const hasUnsavedAgentChanges = useMemo(
    () => !haveSameTalkAgentDraftState(agents, agentDrafts),
    [agentDrafts, agents],
  );
  const hasPendingFooterAgentSelection =
    newAgentDraft.modelId.trim().length > 0;
  const effectiveAgents = hasUnsavedAgentChanges ? agentDrafts : agents;
  useEffect(() => {
    setTargetAgentIds((current) =>
      buildTargetSelection(effectiveAgents, current),
    );
  }, [effectiveAgents]);
  const registeredAgentsById = useMemo(
    () =>
      new Map(
        registeredAgentsCatalog.map((agent) => [agent.id, agent] as const),
      ),
    [registeredAgentsCatalog],
  );
  const talkAgentExecutionGuardrailsById = useMemo(
    () =>
      effectiveAgents.reduce<Record<string, TalkAgentExecutionGuardrail>>(
        (acc, agent) => {
          acc[agent.id] = buildTalkAgentExecutionGuardrail(
            agent,
            registeredAgentsById.get(agent.id),
          );
          return acc;
        },
        {},
      ),
    [effectiveAgents, registeredAgentsById],
  );
  const agentLabelById = useMemo(
    () =>
      effectiveAgents.reduce<Record<string, string>>((acc, agent) => {
        acc[agent.id] = buildAgentLabel(agent);
        return acc;
      }, {}),
    [effectiveAgents],
  );

  const orchestrationMode: TalkOrchestrationMode =
    pageKind === 'ready' && pageTalk ? pageTalk.orchestrationMode : 'ordered';
  const showOrchestrationSelector = agents.length >= 2;
  useEffect(() => {
    if (showOrchestrationSelector && orchestrationState.status !== 'saving') {
      return;
    }
    setOrchestrationMenuOpen(false);
  }, [orchestrationState.status, showOrchestrationSelector]);
  useEffect(() => {
    if (!orchestrationMenuOpen) return;

    const handlePointerDown = (event: MouseEvent) => {
      if (
        orchestrationMenuRef.current &&
        !orchestrationMenuRef.current.contains(event.target as Node)
      ) {
        setOrchestrationMenuOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOrchestrationMenuOpen(false);
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [orchestrationMenuOpen]);
  const selectedTargetAgents = useMemo(
    () => effectiveAgents.filter((agent) => targetAgentIds.includes(agent.id)),
    [effectiveAgents, targetAgentIds],
  );
  const selectedUnavailableAgents = useMemo(
    () =>
      selectedTargetAgents.filter(
        (agent) =>
          talkAgentExecutionGuardrailsById[agent.id]?.kind === 'unavailable',
      ),
    [selectedTargetAgents, talkAgentExecutionGuardrailsById],
  );
  const pendingImageAttachments = useMemo(
    () => pendingAttachments.filter((attachment) => attachment.isImage),
    [pendingAttachments],
  );
  const selectedNonVisionAgents = useMemo(
    () =>
      pendingImageAttachments.length === 0
        ? []
        : selectedTargetAgents.filter(
            (agent) =>
              !talkAgentSupportsVision(
                agent,
                registeredAgentsById.get(agent.id),
                aiAgentsData,
              ),
          ),
    [
      aiAgentsData,
      pendingImageAttachments.length,
      registeredAgentsById,
      selectedTargetAgents,
    ],
  );
  const composerGuardrailMessage = useMemo(() => {
    if (selectedUnavailableAgents.length > 0) {
      const labels = selectedUnavailableAgents.map((agent) =>
        buildAgentLabel(agent),
      );
      if (labels.length === 1) {
        const status =
          talkAgentExecutionGuardrailsById[selectedUnavailableAgents[0]!.id];
        return `${labels[0]} does not have a valid execution path right now. ${
          status?.message || 'Adjust the selected agents before sending.'
        }`;
      }
      return `${summarizeAgentLabels(labels)} do not currently have a valid execution path. Adjust the selected agents before sending.`;
    }

    if (selectedNonVisionAgents.length > 0) {
      const labels = selectedNonVisionAgents.map((agent) =>
        buildAgentLabel(agent),
      );
      if (labels.length === 1) {
        return `${labels[0]} does not support image attachments. Switch to a vision-capable model or remove the images before sending.`;
      }
      return `${summarizeAgentLabels(labels)} do not support image attachments. Switch to vision-capable models or remove the images before sending.`;
    }

    return null;
  }, [
    aiAgentsData,
    selectedNonVisionAgents,
    selectedUnavailableAgents,
    talkAgentExecutionGuardrailsById,
  ]);
  const selectedGuardrailAgentIds = useMemo(
    () =>
      new Set(
        [...selectedUnavailableAgents, ...selectedNonVisionAgents].map(
          (agent) => agent.id,
        ),
      ),
    [selectedNonVisionAgents, selectedUnavailableAgents],
  );
  const sendBlockedByGuardrail = Boolean(composerGuardrailMessage);
  const composerTargetHelp = useMemo(() => {
    if (selectedTargetAgents.length <= 1) {
      return 'Only the selected agent will respond.';
    }
    if (orchestrationMode === 'ordered') {
      return 'Selected agents will respond in order, with the final response synthesizing earlier perspectives.';
    }
    return 'Selected agents will each respond independently.';
  }, [orchestrationMode, selectedTargetAgents.length]);
  const messageLookup = useMemo(
    () =>
      new Map(pageMessages.map((message) => [message.id, message] as const)),
    [pageMessages],
  );
  const sortedThreads = useMemo(
    () => sortThreads(threadState.threads),
    [threadState.threads],
  );
  const activeThread = useMemo(
    () => sortedThreads.find((thread) => thread.id === activeThreadId) || null,
    [activeThreadId, sortedThreads],
  );
  const menuThread = useMemo(
    () =>
      threadMenu
        ? threadState.threads.find(
            (thread) => thread.id === threadMenu.threadId,
          ) || null
        : null,
    [threadMenu, threadState.threads],
  );
  const updateThreadMetadata = useCallback(
    async (
      threadId: string,
      patch: {
        title?: string;
        pinned?: boolean;
      },
    ) => {
      if (pageKind !== 'ready' || !pageTalk) {
        throw new Error('Talk not ready.');
      }
      try {
        const updated = await updateTalkThread({
          talkId: pageTalk.id,
          threadId,
          ...patch,
        });
        setThreadState((current) => ({
          ...current,
          error: null,
          threads: current.threads.map((thread) =>
            thread.id === updated.id
              ? {
                  ...thread,
                  title: updated.title,
                  isPinned: updated.isPinned,
                  updatedAt: updated.updatedAt,
                }
              : thread,
          ),
        }));
        return updated;
      } catch (err) {
        if (err instanceof UnauthorizedError) {
          handleUnauthorized();
        }
        throw err;
      }
    },
    [handleUnauthorized, state],
  );
  const handleRenameThread = useCallback(
    async (threadId: string, title: string) => {
      await updateThreadMetadata(threadId, { title });
      setEditingThreadId((current) => (current === threadId ? null : current));
    },
    [updateThreadMetadata],
  );
  const handleDeleteThread = useCallback(
    async (thread: TalkThread) => {
      if (pageKind !== 'ready' || !pageTalk) return;
      const confirmed = window.confirm(
        `Delete "${formatThreadLabel(thread)}"? This will permanently remove the thread and its messages.`,
      );
      if (!confirmed) return;
      try {
        await deleteTalkThread({
          talkId: pageTalk.id,
          threadId: thread.id,
        });
        // Garbage-collect this thread's doc-pane layout state so we
        // don't leave a stale localStorage record behind.
        if (typeof window !== 'undefined') {
          try {
            window.localStorage.removeItem(`clawtalk_doc_state:${thread.id}`);
          } catch {
            // Quota / private mode — ignore.
          }
        }
        clearThreadScroll(pageTalk.id, thread.id);
        const remaining = sortThreads(
          threadState.threads.filter((candidate) => candidate.id !== thread.id),
        );
        setThreadState((current) => ({
          ...current,
          error: null,
          threads: current.threads.filter(
            (candidate) => candidate.id !== thread.id,
          ),
        }));
        setEditingThreadId((current) =>
          current === thread.id ? null : current,
        );
        if (activeThreadId === thread.id) {
          const fallbackThreadId = remaining[0]?.id || null;
          if (fallbackThreadId) {
            navigate(buildThreadHref(talkId, fallbackThreadId, currentTab));
          }
        }
      } catch (err) {
        if (err instanceof UnauthorizedError) {
          handleUnauthorized();
          return;
        }
        setThreadState((current) => ({
          ...current,
          error:
            err instanceof Error ? err.message : 'Failed to delete thread.',
        }));
      }
    },
    [
      activeThreadId,
      currentTab,
      handleUnauthorized,
      navigate,
      state,
      talkId,
      threadState.threads,
    ],
  );
  const handleRenameActiveThread = useCallback(
    async (title: string) => {
      if (!activeThread) return;
      await handleRenameThread(activeThread.id, title);
    },
    [activeThread, handleRenameThread],
  );
  const {
    runHistory,
    liveResponses,
    orderedGroupSizesById,
    latestOrderedRound,
    activeOrderedProgress,
    talkTimeline,
    activeRound,
    nowTick,
    isDenseRound,
    canEditHistory,
    resolveMessageActorLabel,
  } = useTalkRunViewModel({
    activeThreadId,
    agentLabelById,
    currentTab,
    liveResponsesByRunId: state.liveResponsesByRunId,
    pageKind,
    pageMessages,
    pendingRunHistoryScrollRef,
    runsById: state.runsById,
  });
  const {
    threadAwareTalkTabHref,
    agentsTabHref,
    contextTabHref,
    workspaceConnectorsTabHref,
    jobsTabHref,
    runsTabHref,
    manageAgentsHref,
  } = useTalkDetailTabLinks({ talkId, activeThreadId });
  const handleOpenRunHistory = useCallback(
    (runId: string) => {
      pendingRunHistoryScrollRef.current = runId;
      navigate(runsTabHref);
    },
    [navigate, runsTabHref],
  );
  const manageConnectorsHref = '/app/connectors';
  const isRenaming = renameDraft?.talkId === talkId;

  const openHistoryEditor = useCallback(() => {
    if (pageKind !== 'ready') return;
    if (activeRound) {
      setHistoryEditState({
        status: 'error',
        message:
          'Wait for the current round to finish or cancel it before editing history.',
      });
      return;
    }
    if (!pageMessages.some((message) => message.role !== 'system')) {
      setHistoryEditState({
        status: 'error',
        message: 'There are no editable messages in this Talk yet.',
      });
      return;
    }
    setHistoryEditState({ status: 'idle' });
    setHistoryEditorOpen(true);
  }, [activeRound, state]);

  const handleCloseHistoryEditor = useCallback(() => {
    if (historyEditState.status === 'saving') return;
    setHistoryEditorOpen(false);
    setHistoryEditState((current) =>
      current.status === 'success' ? current : { status: 'idle' },
    );
  }, [historyEditState.status]);

  const handleDeleteHistoryMessages = useCallback(
    async (messageIds: string[]) => {
      if (pageKind !== 'ready' || !pageTalk) return;
      const threadId = activeThreadId;
      if (!threadId) return;
      if (messageIds.length === 0) {
        setHistoryEditState({
          status: 'error',
          message: 'Select at least one message to delete.',
        });
        return;
      }
      const confirmed = window.confirm(
        `Delete ${messageIds.length} selected message${
          messageIds.length === 1 ? '' : 's'
        } from this Talk history?`,
      );
      if (!confirmed) return;

      setHistoryEditState({ status: 'saving' });
      try {
        const result = await deleteTalkMessages({
          talkId: pageTalk.id,
          messageIds,
          threadId,
        });
        threadSnapshotVersionRef.current += 1;
        rememberDeletedMessageIds(result.deletedMessageIds);
        await resyncTalkState({ refreshThreads: true });
        setHistoryEditorOpen(false);
        setHistoryEditState({
          status: 'success',
          message: `Deleted ${result.deletedCount} message${
            result.deletedCount === 1 ? '' : 's'
          } from this Talk history.`,
        });
      } catch (err) {
        if (err instanceof UnauthorizedError) {
          handleUnauthorized();
          return;
        }
        if (err instanceof ApiError && err.code === 'message_not_found') {
          threadSnapshotVersionRef.current += 1;
          rememberDeletedMessageIds(messageIds);
          void resyncTalkState({ refreshThreads: true });
        }
        setHistoryEditState({
          status: 'error',
          message:
            err instanceof Error ? err.message : 'Unable to edit Talk history.',
        });
      }
    },
    [
      activeThreadId,
      handleUnauthorized,
      rememberDeletedMessageIds,
      resyncTalkState,
      state,
    ],
  );

  const mentionFilter = useMemo(() => {
    if (!mentionState) return '';
    const ta = textareaRef.current;
    const cursor = ta?.selectionStart ?? draft.length;
    const between = draft.slice(mentionState.atIndex + 1, cursor);
    // The filter is only the word characters / hyphens immediately
    // after `@`. Any whitespace ends the filter (and the mention).
    if (/\s/.test(between)) return between.split(/\s/)[0] ?? '';
    return between;
  }, [draft, mentionState]);

  const mentionOptions = useMemo(
    () =>
      buildSourceMentionOptions({
        sources: contextSources,
        filter: mentionFilter,
        contentTitle: talkContent ? talkContent.title : null,
      }),
    [contextSources, mentionFilter, talkContent],
  );

  // Keep the highlighted index inside the valid range as the filter
  // text shrinks/grows the option list. When options become empty we
  // dismiss the picker so the user sees their literal `@filter` text.
  useEffect(() => {
    if (!mentionState) return;
    if (mentionOptions.length === 0) {
      setMentionState(null);
      return;
    }
    if (mentionState.selectedIndex >= mentionOptions.length) {
      setMentionState({
        atIndex: mentionState.atIndex,
        selectedIndex: 0,
      });
    }
  }, [mentionOptions.length, mentionState]);

  const insertMentionOption = useCallback(
    (option: SourceMentionOption) => {
      if (!mentionState) return;
      const ta = textareaRef.current;
      const cursor = ta?.selectionStart ?? draft.length;
      const before = draft.slice(0, mentionState.atIndex);
      // Everything from `@` through the cursor (including the filter
      // chars the user typed) is replaced by the canonical insertion.
      const after = draft.slice(cursor);
      const inserted = option.insertion;
      const next = before + inserted + after;
      setDraft(next);
      setMentionState(null);
      requestAnimationFrame(() => {
        const taNow = textareaRef.current;
        if (!taNow) return;
        taNow.focus();
        const nextCursor = before.length + inserted.length;
        taNow.setSelectionRange(nextCursor, nextCursor);
      });
    },
    [draft, mentionState],
  );

  const handleDraftChange = (value: string) => {
    setDraft(value);
    if (pageKind === 'ready' && state.sendState.status === 'error') {
      dispatch({ type: 'SEND_CLEARED' });
    }
    // `@` trigger: open the mention picker when the user types `@` at a
    // word boundary AND the Talk has either an attached doc or at least
    // one ready saved source. The literal `@` stays in the textarea;
    // selection replaces the `@filter` slice with the canonical token.
    const hasMentionable =
      !!talkContent ||
      contextSources.some((source) => source.status === 'ready');
    if (hasMentionable) {
      const ta = textareaRef.current;
      const pos = ta?.selectionStart ?? value.length;
      const atIndex = pos - 1;
      if (atIndex >= 0 && value[atIndex] === '@') {
        const prev = atIndex > 0 ? value[atIndex - 1] : '';
        const atWordBoundary = atIndex === 0 || /\s/.test(prev);
        if (atWordBoundary) {
          setMentionState({ atIndex, selectedIndex: 0 });
          return;
        }
      }
    }
    // Dismiss the picker if the cursor moved past the `@<filter>` span
    // (e.g. the user inserted a space or backspaced over the `@`).
    if (mentionState) {
      const ta = textareaRef.current;
      const cursor = ta?.selectionStart ?? value.length;
      if (
        cursor <= mentionState.atIndex ||
        value[mentionState.atIndex] !== '@'
      ) {
        setMentionState(null);
      }
    }
  };

  const resizeComposerTextarea = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    const scrollHeight = Math.max(
      textarea.scrollHeight,
      COMPOSER_TEXTAREA_MIN_HEIGHT_PX,
    );
    const nextHeight = Math.min(scrollHeight, COMPOSER_TEXTAREA_MAX_HEIGHT_PX);
    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY =
      scrollHeight > COMPOSER_TEXTAREA_MAX_HEIGHT_PX ? 'auto' : 'hidden';
  }, []);

  useEffect(() => {
    resizeComposerTextarea();
  }, [activeThreadId, currentTab, draft, resizeComposerTextarea, pageKind]);

  const ALLOWED_ATTACHMENT_EXTENSIONS =
    '.txt,.md,.csv,.html,.rtf,' +
    '.json,.xml,.yaml,.yml,.py,.js,.ts,.jsx,.tsx,.java,.c,.h,.cpp,.hpp,.go,.rs,.sh,.bash,.sql,.rb,.php,.swift,.kt,.lua,.r,.toml,.ini,.cfg,.env,.log,' +
    '.pdf,.docx,.xlsx,.pptx,.png,.jpg,.jpeg,.webp';
  const ALLOWED_ATTACHMENT_MIMES = new Set([
    // Text-based (existing)
    'text/plain',
    'text/markdown',
    'text/csv',
    'text/html',
    // NEW: RTF
    'text/rtf',
    'application/rtf',
    // NEW: Code / structured data (treated as plain text)
    'text/xml',
    'application/json',
    'application/xml',
    'text/yaml',
    'text/x-yaml',
    'application/x-yaml',
    'text/x-python',
    'text/x-java',
    'text/javascript',
    'application/javascript',
    'text/typescript',
    'text/x-c',
    'text/x-c++',
    'text/x-go',
    'text/x-rust',
    'text/x-shellscript',
    'text/x-sql',
    // Documents (existing + PPTX)
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'image/png',
    'image/jpeg',
    'image/webp',
  ]);
  const IMAGE_ATTACHMENT_MIMES = new Set([
    'image/png',
    'image/jpeg',
    'image/webp',
  ]);
  const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024;
  const MAX_IMAGE_ATTACHMENT_SIZE = 5 * 1024 * 1024;
  const MAX_ATTACHMENTS_PER_MESSAGE = 5;
  const MAX_IMAGE_ATTACHMENTS_PER_MESSAGE = 3;

  const inferAttachmentMimeType = (file: File): string => {
    if (ALLOWED_ATTACHMENT_MIMES.has(file.type)) {
      return file.type;
    }
    const lowerName = file.name.toLowerCase();
    if (lowerName.endsWith('.png')) return 'image/png';
    if (lowerName.endsWith('.jpg') || lowerName.endsWith('.jpeg')) {
      return 'image/jpeg';
    }
    if (lowerName.endsWith('.webp')) return 'image/webp';
    return file.type;
  };

  const handleFilesSelected = async (files: FileList | File[]) => {
    if (!pageTalk || !GREENFIELD_MESSAGE_ATTACHMENTS_ENABLED) return;
    const fileArray = Array.from(files);
    const currentCount = pendingAttachments.length;
    if (currentCount + fileArray.length > MAX_ATTACHMENTS_PER_MESSAGE) {
      dispatch({
        type: 'SEND_FAILED',
        message: `You can attach up to ${MAX_ATTACHMENTS_PER_MESSAGE} files per message.`,
        lastDraft: draft,
      });
      return;
    }

    const currentImageCount = pendingAttachments.filter(
      (attachment) => attachment.isImage,
    ).length;
    const incomingImageCount = fileArray.filter((file) =>
      IMAGE_ATTACHMENT_MIMES.has(inferAttachmentMimeType(file)),
    ).length;
    if (
      currentImageCount + incomingImageCount >
      MAX_IMAGE_ATTACHMENTS_PER_MESSAGE
    ) {
      dispatch({
        type: 'SEND_FAILED',
        message: `You can attach up to ${MAX_IMAGE_ATTACHMENTS_PER_MESSAGE} images per message.`,
        lastDraft: draft,
      });
      return;
    }

    for (const file of fileArray) {
      const mimeType = inferAttachmentMimeType(file);
      const isImage = IMAGE_ATTACHMENT_MIMES.has(mimeType);

      if (!ALLOWED_ATTACHMENT_MIMES.has(mimeType) && file.type !== '') {
        dispatch({
          type: 'SEND_FAILED',
          message: `File type "${file.type}" is not supported. Supported: text, markdown, CSV, HTML, RTF, PDF, DOCX, XLSX, PPTX, PNG, JPEG, WEBP, and common code/config files.`,
          lastDraft: draft,
        });
        continue;
      }
      const maxSize = isImage ? MAX_IMAGE_ATTACHMENT_SIZE : MAX_ATTACHMENT_SIZE;
      if (file.size > maxSize) {
        dispatch({
          type: 'SEND_FAILED',
          message: `"${file.name}" exceeds the ${maxSize / (1024 * 1024)} MB size limit.`,
          lastDraft: draft,
        });
        continue;
      }

      const localId = `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const previewUrl = isImage ? URL.createObjectURL(file) : undefined;
      setPendingAttachments((prev) => [
        ...prev,
        {
          localId,
          file,
          fileName: file.name,
          fileSize: file.size,
          mimeType,
          isImage,
          previewUrl,
          status: 'uploading',
        },
      ]);

      try {
        const result = await uploadTalkAttachment(pageTalk!.id, file);
        setPendingAttachments((prev) =>
          prev.map((a) =>
            a.localId === localId
              ? {
                  ...a,
                  status: 'ready' as const,
                  attachmentId: result.attachment.id,
                }
              : a,
          ),
        );
      } catch (err) {
        setPendingAttachments((prev) =>
          prev.map((a) =>
            a.localId === localId
              ? {
                  ...a,
                  status: 'error' as const,
                  errorMessage:
                    err instanceof Error ? err.message : 'Upload failed',
                }
              : a,
          ),
        );
      }
    }
  };

  const handleRemoveAttachment = (localId: string) => {
    setPendingAttachments((prev) => {
      const next: typeof prev = [];
      for (const attachment of prev) {
        if (attachment.localId === localId) {
          if (attachment.previewUrl) {
            URL.revokeObjectURL(attachment.previewUrl);
          }
          continue;
        }
        next.push(attachment);
      }
      return next;
    });
  };

  const handleAttachButtonClick = () => {
    if (!GREENFIELD_MESSAGE_ATTACHMENTS_ENABLED) return;
    fileInputRef.current?.click();
  };

  const handleFileInputChange = (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    if (event.target.files && event.target.files.length > 0) {
      void handleFilesSelected(event.target.files);
      event.target.value = '';
    }
  };

  const [isDragOver, setIsDragOver] = useState(false);
  const dragCounterRef = useRef(0);
  useEffect(() => {
    pendingAttachmentsRef.current = pendingAttachments;
  }, [pendingAttachments]);

  const handleDragEnter = (event: React.DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (!GREENFIELD_MESSAGE_ATTACHMENTS_ENABLED) return;
    dragCounterRef.current += 1;
    if (hasFileTransfer(event.dataTransfer)) {
      setIsDragOver(true);
    }
  };

  const handleDragLeave = (event: React.DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (!GREENFIELD_MESSAGE_ATTACHMENTS_ENABLED) return;
    dragCounterRef.current = Math.max(0, dragCounterRef.current - 1);
    if (dragCounterRef.current === 0) {
      setIsDragOver(false);
    }
  };

  const handleDragOver = (event: React.DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (
      GREENFIELD_MESSAGE_ATTACHMENTS_ENABLED &&
      hasFileTransfer(event.dataTransfer)
    ) {
      event.dataTransfer.dropEffect = 'copy';
    }
  };

  const handleDrop = (event: React.DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    dragCounterRef.current = 0;
    setIsDragOver(false);
    if (
      GREENFIELD_MESSAGE_ATTACHMENTS_ENABLED &&
      event.dataTransfer.files.length > 0
    ) {
      void handleFilesSelected(event.dataTransfer.files);
    }
  };

  useEffect(() => {
    return () => {
      pendingAttachmentsRef.current.forEach((attachment) => {
        if (attachment.previewUrl) {
          URL.revokeObjectURL(attachment.previewUrl);
        }
      });
    };
  }, []);

  useEffect(() => {
    // Always start a tab visit with a clean drag-overlay state — even
    // when we just switched TO 'talk'. The workspace dragCounter can
    // stick at >0 if a child dropzone in another tab (e.g. the Context
    // tab's SavedSourcesPanel) stops propagation on its own drop,
    // leaving the workspace's matching dragLeave unfired. Without this
    // reset, switching back to the Talk tab would re-render the
    // overlay with no live drag in progress.
    dragCounterRef.current = 0;
    setIsDragOver(false);

    if (currentTab !== 'talk') return;

    const preventWindowFileNavigation = (event: DragEvent) => {
      if (!hasFileTransfer(event.dataTransfer)) return;
      event.preventDefault();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = GREENFIELD_MESSAGE_ATTACHMENTS_ENABLED
          ? 'copy'
          : 'none';
      }
      if (event.type === 'drop') {
        dragCounterRef.current = 0;
        setIsDragOver(false);
      }
    };

    window.addEventListener('dragenter', preventWindowFileNavigation, true);
    window.addEventListener('dragover', preventWindowFileNavigation, true);
    window.addEventListener('drop', preventWindowFileNavigation, true);

    return () => {
      window.removeEventListener(
        'dragenter',
        preventWindowFileNavigation,
        true,
      );
      window.removeEventListener('dragover', preventWindowFileNavigation, true);
      window.removeEventListener('drop', preventWindowFileNavigation, true);
    };
  }, [currentTab]);

  const handleToggleTarget = (agentId: string) => {
    setTargetAgentIds((current) => {
      const selected = current.includes(agentId);
      if (selected) {
        if (current.length === 1) return current;
        return current.filter((id) => id !== agentId);
      }
      return [...current, agentId];
    });
    if (pageKind === 'ready' && state.sendState.status === 'error') {
      dispatch({ type: 'SEND_CLEARED' });
    }
  };

  const queueTalkMessage = useCallback(
    async (input: {
      content: string;
      targetAgentIds: string[];
      attachmentIds?: string[];
    }) => {
      if (pageKind !== 'ready' || !pageTalk || !activeThreadId) {
        throw new Error('Thread unavailable.');
      }

      const result = await sendTalkMessage({
        workspaceId: activeTalkWorkspaceId,
        talkId: pageTalk.id,
        content: input.content,
        targetAgentIds: input.targetAgentIds,
        attachmentIds: input.attachmentIds,
        threadId: activeThreadId,
      });
      // The user just submitted — show them where their message landed, even
      // if they were scrolled up reading earlier history. Mark them following
      // so the guarded auto-stick scroll goes through; subsequent agent
      // responses still go through the usual nearBottom gate, so a user who
      // scrolls away mid-stream won't get yanked back.
      followBottomRef.current = true;
      autoStickToBottomRef.current = 'smooth';
      appendTalkMessageToSnapshot({
        queryClient,
        userId,
        talkId,
        message: result.message,
      });
      dispatch({
        type: 'MESSAGE_LANDED',
        wasNearBottom: true,
        message: result.message,
      });
      for (const run of result.runs) {
        dispatch({
          type: 'RUN_QUEUED',
          runId: run.id,
          threadId: run.threadId,
          triggerMessageId: run.triggerMessageId,
          createdAt: run.createdAt,
          targetAgentId: run.targetAgentId,
          targetAgentNickname: run.targetAgentNickname,
          responseGroupId: run.responseGroupId,
          sequenceIndex: run.sequenceIndex,
          executorAlias: run.executorAlias,
          executorModel: run.executorModel,
        });
      }
      return result;
    },
    [activeTalkWorkspaceId, activeThreadId, pageKind, pageTalk],
  );

  const submitDraft = async () => {
    if (pageKind !== 'ready' || !pageTalk || !activeThreadId) return;

    const content = draft.trim();
    if (!content) {
      dispatch({
        type: 'SEND_FAILED',
        message: 'Message content is required.',
        lastDraft: draft,
      });
      return;
    }
    if (content === '/edit') {
      setDraft('');
      dispatch({ type: 'SEND_CLEARED' });
      openHistoryEditor();
      return;
    }
    if (content.length > TALK_MESSAGE_MAX_CHARS) {
      dispatch({
        type: 'SEND_FAILED',
        message: `Message exceeds ${TALK_MESSAGE_MAX_CHARS} characters.`,
        lastDraft: content,
      });
      return;
    }
    if (activeRound) {
      dispatch({
        type: 'SEND_FAILED',
        message: 'Wait for the current round to finish or cancel it first.',
        lastDraft: content,
      });
      return;
    }
    if (hasUnsavedAgentChanges) {
      dispatch({
        type: 'SEND_FAILED',
        message: 'Save agent changes before sending a message.',
        lastDraft: content,
      });
      return;
    }
    if (composerGuardrailMessage) {
      dispatch({
        type: 'SEND_FAILED',
        message: composerGuardrailMessage,
        lastDraft: content,
      });
      return;
    }

    // Collect ready attachment IDs
    const readyAttachments = pendingAttachments.filter(
      (a) => a.status === 'ready' && a.attachmentId,
    );
    const stillUploading = pendingAttachments.some(
      (a) => a.status === 'uploading',
    );
    if (stillUploading) {
      dispatch({
        type: 'SEND_FAILED',
        message: 'Wait for file uploads to finish before sending.',
        lastDraft: content,
      });
      return;
    }

    dispatch({ type: 'SEND_STARTED' });
    try {
      await queueTalkMessage({
        content,
        targetAgentIds,
        attachmentIds: readyAttachments.map((a) => a.attachmentId!),
      });
      pendingAttachments.forEach((attachment) => {
        if (attachment.previewUrl) {
          URL.revokeObjectURL(attachment.previewUrl);
        }
      });
      setDraft('');
      setPendingAttachments([]);
      dispatch({ type: 'SEND_CLEARED' });
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        handleUnauthorized();
        return;
      }
      dispatch({
        type: 'SEND_FAILED',
        message: err instanceof Error ? err.message : 'Failed to send message',
        lastDraft: content,
      });
    }
  };

  const handleRetryAgentRun = useCallback(
    async (runId: string) => {
      if (pageKind !== 'ready' || !pageTalk || !activeThreadId) return;
      if (activeRound) {
        setRetryRunState({
          runId,
          status: 'error',
          message: 'Wait for the current round to finish or cancel it first.',
        });
        return;
      }
      if (hasUnsavedAgentChanges) {
        setRetryRunState({
          runId,
          status: 'error',
          message: 'Save agent changes before retrying this agent.',
        });
        return;
      }

      const run = state.runsById[runId];
      const triggerMessage = pageMessages.find(
        (message) =>
          message.id === run?.triggerMessageId && message.role === 'user',
      );
      if (!run?.targetAgentId || !triggerMessage?.content.trim()) {
        setRetryRunState({
          runId,
          status: 'error',
          message: 'The original prompt is unavailable for this retry.',
        });
        return;
      }

      setRetryRunState({
        runId,
        status: 'posting',
        message: 'Retrying this agent from the original prompt…',
      });
      try {
        await queueTalkMessage({
          content: triggerMessage.content,
          targetAgentIds: [run.targetAgentId],
        });
        setRetryRunState(null);
        dispatch({ type: 'SEND_CLEARED' });
      } catch (error) {
        if (error instanceof UnauthorizedError) {
          setRetryRunState(null);
          handleUnauthorized();
          return;
        }
        setRetryRunState({
          runId,
          status: 'error',
          message:
            error instanceof Error
              ? error.message
              : 'Unable to retry this agent.',
        });
      }
    },
    [
      activeRound,
      activeThreadId,
      handleUnauthorized,
      hasUnsavedAgentChanges,
      queueTalkMessage,
      pageKind,
      pageMessages,
      state.runsById,
      pageTalk,
    ],
  );

  const handleSend = (event: FormEvent) => {
    event.preventDefault();
    void submitDraft();
  };

  const handleComposerKeyDown = (
    event: ReactKeyboardEvent<HTMLTextAreaElement>,
  ) => {
    if (mentionState && mentionOptions.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setMentionState({
          atIndex: mentionState.atIndex,
          selectedIndex: Math.min(
            mentionState.selectedIndex + 1,
            mentionOptions.length - 1,
          ),
        });
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setMentionState({
          atIndex: mentionState.atIndex,
          selectedIndex: Math.max(mentionState.selectedIndex - 1, 0),
        });
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        const option = mentionOptions[mentionState.selectedIndex];
        if (option) insertMentionOption(option);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setMentionState(null);
        return;
      }
    }
    if (
      event.key !== 'Enter' ||
      event.shiftKey ||
      event.nativeEvent.isComposing ||
      event.keyCode === 229
    ) {
      return;
    }
    event.preventDefault();
    void submitDraft();
  };

  const handleCancelRuns = async () => {
    if (pageKind !== 'ready' || !pageTalk || !activeThreadId) return;
    dispatch({ type: 'CANCEL_STARTED' });
    try {
      const result = await cancelTalkRuns(pageTalk.id, activeThreadId, {
        workspaceId: activeTalkWorkspaceId,
      });
      dispatch({
        type: 'CANCEL_SUCCEEDED',
        message: `Cancelled ${result.cancelledRuns} run${result.cancelledRuns === 1 ? '' : 's'}.`,
      });
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        handleUnauthorized();
        return;
      }
      dispatch({
        type: 'CANCEL_FAILED',
        message: err instanceof Error ? err.message : 'Failed to cancel runs',
      });
    }
  };

  const handleSelectThread = useCallback(
    (threadId: string) => {
      navigate(buildThreadHref(talkId, threadId, currentTab));
    },
    [currentTab, navigate, talkId],
  );

  const openThreadMenu = useCallback(
    (threadId: string, x: number, y: number) => {
      if (!canEditAgents) return;
      setThreadMenu({ threadId, x, y });
    },
    [canEditAgents],
  );

  const handleThreadSecondaryClick = useCallback(
    (threadId: string) => (event: ReactMouseEvent<HTMLElement>) => {
      if (event.button !== 2) return;
      event.preventDefault();
      event.stopPropagation();
      openThreadMenu(threadId, event.clientX, event.clientY);
    },
    [openThreadMenu],
  );

  const handleThreadContextMenu = useCallback(
    (threadId: string) => (event: ReactMouseEvent<HTMLElement>) => {
      event.preventDefault();
      event.stopPropagation();
      openThreadMenu(threadId, event.clientX, event.clientY);
    },
    [openThreadMenu],
  );

  const handleOrchestrationModeChange = useCallback(
    async (nextMode: TalkOrchestrationMode) => {
      if (pageKind !== 'ready' || !pageTalk) return;
      if (pageTalk.orchestrationMode === nextMode) return;

      setOrchestrationState({ status: 'saving' });
      try {
        const updatedTalk = await patchTalkMetadata({
          talkId: pageTalk.id,
          orchestrationMode: nextMode,
        });
        patchTalkInSnapshot({
          queryClient,
          userId,
          talkId,
          threadId: activeThreadIdRef.current,
          patch: {
            orchestrationMode: updatedTalk.orchestrationMode,
            title: updatedTalk.title,
            version: updatedTalk.version,
            updatedAt: updatedTalk.updatedAt,
          },
        });
        setOrchestrationState({ status: 'idle' });
      } catch (err) {
        if (err instanceof UnauthorizedError) {
          handleUnauthorized();
          return;
        }
        setOrchestrationState({
          status: 'error',
          message:
            err instanceof Error
              ? err.message
              : 'Failed to update response mode.',
        });
      }
    },
    [handleUnauthorized, pageKind, pageTalk, queryClient, talkId, userId],
  );

  const handleCreateThread = useCallback(async () => {
    if (pageKind !== 'ready' || !pageTalk) return;
    try {
      const nextThread = await createTalkThread({ talkId: pageTalk.id });
      setThreadState((current) => ({
        ...current,
        threads: sortThreads([nextThread, ...current.threads]),
      }));
      pendingComposerFocusRef.current = true;
      navigate(buildThreadHref(talkId, nextThread.id, currentTab));
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        handleUnauthorized();
        return;
      }
      setThreadState((current) => ({
        ...current,
        error: err instanceof Error ? err.message : 'Failed to create thread.',
      }));
    }
  }, [currentTab, handleUnauthorized, navigate, state, talkId]);

  const handleSearch = useCallback(async () => {
    const query = searchQueryRef.current.trim();
    if (!query) {
      setSearchResults([]);
      setSearchError(null);
      return;
    }
    setSearchLoading(true);
    setSearchError(null);
    try {
      const results = await searchTalkMessages({ talkId, query });
      setSearchResults(results);
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        handleUnauthorized();
        return;
      }
      setSearchError(
        err instanceof Error ? err.message : 'Failed to search talk messages.',
      );
    } finally {
      setSearchLoading(false);
    }
  }, [handleUnauthorized, talkId]);

  const handleSearchResultSelect = useCallback(
    (result: TalkMessageSearchResult) => {
      setSearchResults([]);
      navigate(buildThreadHref(talkId, result.threadId));
    },
    [navigate, talkId],
  );

  const handleClearUnread = () => {
    // User chose to jump to the newest — resume following.
    followBottomRef.current = true;
    scrollToBottom('smooth');
    dispatch({ type: 'CLEAR_UNREAD' });
  };

  const handleAgentSourceChange = (
    agentId: string,
    sourceKind: 'claude_default' | 'provider',
    providerId: string | null,
  ) => {
    setAgentDrafts((current) =>
      current.map((agent) => {
        if (agent.id !== agentId) return agent;
        const suggestions = getModelSuggestionsForSource({
          sourceKind,
          providerId,
          aiAgents: aiAgentsData,
        });
        const nextModelId =
          suggestions.find((entry) => entry.modelId === agent.modelId)
            ?.modelId ||
          suggestions[0]?.modelId ||
          '';
        return applySourceModelSelection(
          agent,
          { sourceKind, providerId, modelId: nextModelId },
          current,
          aiAgentsData,
        );
      }),
    );
    setAgentState({ status: 'idle' });
  };

  const handleAgentModelChange = (agentId: string, modelId: string) => {
    setAgentDrafts((current) =>
      current.map((agent) =>
        agent.id === agentId
          ? applySourceModelSelection(
              agent,
              {
                sourceKind: agent.sourceKind,
                providerId:
                  agent.sourceKind === 'provider' ? agent.providerId : null,
                modelId,
              },
              current,
              aiAgentsData,
            )
          : agent,
      ),
    );
    setAgentState({ status: 'idle' });
  };

  const handleAgentNicknameChange = (agentId: string, nickname: string) => {
    setAgentDrafts((current) =>
      current.map((agent) =>
        agent.id === agentId
          ? {
              ...agent,
              nickname,
              nicknameMode: 'custom',
            }
          : agent,
      ),
    );
    setAgentState({ status: 'idle' });
  };

  const handleResetNickname = (agentId: string) => {
    setAgentDrafts((current) =>
      current.map((agent) => {
        if (agent.id !== agentId) return agent;
        // Use registered agent name if available, otherwise fall back to
        // the old source-based nickname builder.
        const regAgent = registeredAgentsCatalog.find(
          (ra) => ra.id === agent.id,
        );
        const base = regAgent
          ? regAgent.name
          : buildAutoNicknameBase({
              sourceKind: agent.sourceKind,
              providerId: agent.providerId,
              modelId: agent.modelId,
              modelDisplayName: agent.modelDisplayName,
              aiAgents: aiAgentsData,
            });
        return {
          ...agent,
          nickname: buildUniqueNickname(base, current, agent.id),
          nicknameMode: 'auto',
        };
      }),
    );
    setAgentState({ status: 'idle' });
  };

  const handleAgentRoleChange = (agentId: string, role: TalkAgent['role']) => {
    setAgentDrafts((current) =>
      current.map((agent) =>
        agent.id === agentId ? { ...agent, role } : agent,
      ),
    );
    setAgentState({ status: 'idle' });
  };

  const handleSetPrimaryAgent = (agentId: string) => {
    setAgentDrafts((current) =>
      current.map((agent) => ({
        ...agent,
        isPrimary: agent.id === agentId,
      })),
    );
    setAgentState({ status: 'idle' });
  };

  const handleRemoveAgent = (agentId: string) => {
    setAgentDrafts((current) => {
      const remaining = current.filter((agent) => agent.id !== agentId);
      if (remaining.length === 0) return current;
      if (!remaining.some((agent) => agent.isPrimary)) {
        remaining[0] = { ...remaining[0], isPrimary: true };
      }
      return remaining.map((agent, index) => ({
        ...agent,
        displayOrder: index,
      }));
    });
    setTargetAgentIds((current) => {
      const next = current.filter((id) => id !== agentId);
      return next.length > 0 ? next : [];
    });
    setAgentState({ status: 'idle' });
  };

  const materializePendingFooterAgent = (
    currentDrafts: TalkAgent[],
  ): {
    nextAgents: TalkAgent[];
    nextDraft: AgentCreationDraft;
    added: boolean;
    error: string | null;
  } => {
    const selectedAgentId = newAgentDraft.modelId.trim();
    if (!selectedAgentId) {
      return {
        nextAgents: currentDrafts,
        nextDraft: newAgentDraft,
        added: false,
        error: null,
      };
    }

    const regAgent = registeredAgentsCatalog.find(
      (ra) => ra.id === selectedAgentId && ra.enabled,
    );
    if (!regAgent) {
      return {
        nextAgents: currentDrafts,
        nextDraft: newAgentDraft,
        added: false,
        error:
          'Selected registered agent is no longer available. Refresh and try again.',
      };
    }

    if (currentDrafts.some((agent) => agent.id === regAgent.id)) {
      return {
        nextAgents: currentDrafts,
        nextDraft: newAgentDraft,
        added: false,
        error: 'Selected registered agent is already assigned to this talk.',
      };
    }

    const nickname = buildUniqueNickname(regAgent.name, currentDrafts);
    return {
      nextAgents: [
        ...currentDrafts,
        {
          id: regAgent.id,
          nickname,
          nicknameMode: 'auto',
          sourceKind: 'provider',
          role: newAgentDraft.role,
          isPrimary: false,
          displayOrder: currentDrafts.length,
          health: 'ready',
          providerId: regAgent.providerId,
          modelId: regAgent.modelId,
          modelDisplayName: null,
          // Capabilities are resolved server-side; an unsaved draft defaults
          // to false. Drafts don't drive the render-pages affordance — that
          // reads the persisted `agents` list, not `agentDrafts`.
          supportsVision: false,
          supportsPdfDocuments: false,
        },
      ],
      nextDraft: {
        ...newAgentDraft,
        modelId: '',
        providerId: null,
      },
      added: true,
      error: null,
    };
  };

  const handleAddAgent = () => {
    const materialized = materializePendingFooterAgent(agentDrafts);
    if (materialized.error) {
      setAgentState({ status: 'error', message: materialized.error });
      return;
    }
    if (!materialized.added) return;
    setAgentDrafts(materialized.nextAgents);
    setNewAgentDraft(materialized.nextDraft);
    setAgentState({ status: 'idle' });
  };

  const handleSaveAgents = async () => {
    if (pageKind !== 'ready' || !pageTalk || !canEditAgents) return;
    const materialized = materializePendingFooterAgent(agentDrafts);
    if (materialized.error) {
      setAgentState({ status: 'error', message: materialized.error });
      return;
    }
    if (materialized.added) {
      setAgentDrafts(materialized.nextAgents);
      setNewAgentDraft(materialized.nextDraft);
    }
    setAgentState({ status: 'saving' });
    try {
      const saved = await updateTalkAgents({
        talkId: pageTalk.id,
        agents: materialized.nextAgents.map((agent, index) => ({
          id: agent.id,
          nickname: agent.nickname.trim(),
          nicknameMode: agent.nicknameMode,
          sourceKind: agent.sourceKind,
          providerId: agent.sourceKind === 'provider' ? agent.providerId : null,
          modelId: agent.modelId,
          modelDisplayName: agent.modelDisplayName,
          role: agent.role,
          isPrimary: agent.isPrimary,
          displayOrder: index,
          health: agent.health,
          supportsVision: agent.supportsVision,
          supportsPdfDocuments: agent.supportsPdfDocuments,
        })),
      });
      setAgents(saved);
      setAgentDrafts(saved);
      setNewAgentDraft(materialized.nextDraft);
      setTargetAgentIds((current) => buildTargetSelection(saved, current));
      setAgentState({ status: 'success', message: 'Talk agents updated.' });
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        handleUnauthorized();
        return;
      }
      setAgentState({
        status: 'error',
        message:
          err instanceof Error ? err.message : 'Failed to update talk agents',
      });
    }
  };

  const handleToggleRunContext = useCallback(
    async (runId: string) => {
      const current = runContextPanelsRef.current[runId];
      if (current?.open) {
        setRunContextPanels((existing) => ({
          ...existing,
          [runId]: {
            ...(existing[runId] || {
              open: false,
              status: 'idle',
              snapshot: null,
            }),
            open: false,
          },
        }));
        return;
      }

      if (current?.status === 'loaded') {
        setRunContextPanels((existing) => ({
          ...existing,
          [runId]: {
            ...(existing[runId] || {
              open: false,
              status: 'idle',
              snapshot: null,
            }),
            open: true,
          },
        }));
        return;
      }

      setRunContextPanels((existing) => ({
        ...existing,
        [runId]: {
          open: true,
          status: 'loading',
          snapshot: existing[runId]?.snapshot ?? null,
        },
      }));

      try {
        const snapshot = await getTalkRunContext({ talkId, runId });
        setRunContextPanels((existing) => ({
          ...existing,
          [runId]: {
            open: true,
            status: 'loaded',
            snapshot,
          },
        }));
      } catch (err) {
        if (err instanceof UnauthorizedError) {
          handleUnauthorized();
          return;
        }
        setRunContextPanels((existing) => ({
          ...existing,
          [runId]: {
            open: true,
            status: 'error',
            snapshot: null,
            message:
              err instanceof Error
                ? err.message
                : 'Failed to load run context.',
          },
        }));
      }
    },
    [handleUnauthorized, talkId],
  );

  const jumpToMessage = (messageId: string) => {
    const element = messageElementRefs.current.get(messageId);
    if (!element) return;
    element.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  const handleOpenRunTrigger = useCallback(
    (run: TalkRun) => {
      if (!run.threadId) return;
      if (run.threadId !== activeThreadId) {
        navigate(buildThreadHref(talkId, run.threadId));
        return;
      }
      if (run.triggerMessageId) {
        jumpToMessage(run.triggerMessageId);
      }
    },
    [activeThreadId, navigate, talkId],
  );

  useEffect(() => {
    if (!isRenaming) return;
    titleInputRef.current?.focus();
    titleInputRef.current?.select();
  }, [isRenaming]);

  if (pageKind === 'loading') {
    return <p className="page-state">Loading talk…</p>;
  }

  if (pageKind === 'unavailable') {
    return (
      <section className="page-state">
        <h2>Talk Unavailable</h2>
        <p>{pageErrorMessage || 'Talk not found.'}</p>
        <Link to="/app/talks">Back to talks</Link>
      </section>
    );
  }

  if (pageKind === 'error' || !pageTalk) {
    return (
      <section className="page-state">
        <h2>Talk Error</h2>
        <p>{pageErrorMessage || 'Failed to load talk.'}</p>
        <Link to="/app/talks">Back to talks</Link>
      </section>
    );
  }

  const talk = pageTalk;
  const displayedTitle = titleOverride || talk.title;

  return (
    <section className="page-shell talk-detail-shell">
      <div
        className={`talk-workspace${isDragOver ? ' talk-workspace-drag-over' : ''}`}
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
      >
        {isDragOver ? (
          <div className="talk-workspace-drop-overlay">
            Drop files to attach
          </div>
        ) : null}
        <TalkDetailShell
          talkId={talkId}
          displayedTitle={displayedTitle}
          isRenaming={isRenaming}
          renameDraft={renameDraft}
          titleInputRef={titleInputRef}
          onRenameDraftChange={onRenameDraftChange}
          onRenameDraftCancel={onRenameDraftCancel}
          onRenameDraftCommit={onRenameDraftCommit}
          currentTab={currentTab}
          tabLinks={{
            threadAwareTalkTabHref,
            agentsTabHref,
            contextTabHref,
            workspaceConnectorsTabHref,
            jobsTabHref,
            runsTabHref,
            manageAgentsHref,
          }}
          activeRuleCount={activeRuleCount}
          showOrchestrationSelector={showOrchestrationSelector}
          orchestrationMenuRef={orchestrationMenuRef}
          orchestrationMenuOpen={orchestrationMenuOpen}
          setOrchestrationMenuOpen={setOrchestrationMenuOpen}
          orchestrationMode={orchestrationMode}
          orchestrationState={orchestrationState}
          onOrchestrationModeChange={(mode) => {
            void handleOrchestrationModeChange(mode);
          }}
          currentThreadHasContent={currentThreadHasContent}
          openDocModal={openDocModal}
          effectiveAgents={effectiveAgents}
          talkAgentExecutionGuardrailsById={talkAgentExecutionGuardrailsById}
        />

        <div
          className={`talk-workspace-scroll${
            currentTab === 'talk' ? ' talk-workspace-scroll-talk' : ''
          }`}
        >
          {currentTab === 'agents' ? (
            <TalkAgentsPanel
              agentDrafts={agentDrafts}
              setAgentDrafts={setAgentDrafts}
              newAgentDraft={newAgentDraft}
              setNewAgentDraft={setNewAgentDraft}
              agentState={agentState}
              setAgentState={setAgentState}
              agentsCatalogError={agentsCatalogError}
              registeredAgentsCatalog={registeredAgentsCatalog}
              canEditAgents={canEditAgents}
              hasPendingFooterAgentSelection={hasPendingFooterAgentSelection}
              manageAgentsHref={manageAgentsHref}
              handleAgentNicknameChange={handleAgentNicknameChange}
              handleAgentRoleChange={handleAgentRoleChange}
              handleSetPrimaryAgent={handleSetPrimaryAgent}
              handleResetNickname={handleResetNickname}
              handleRemoveAgent={handleRemoveAgent}
              handleAddAgent={handleAddAgent}
              handleSaveAgents={handleSaveAgents}
            />
          ) : null}

          {currentTab === 'context' ? (
            <section className="talk-tab-panel" aria-label="Talk context">
              {contextStatus.status === 'loading' ? (
                <p className="page-state">Loading context…</p>
              ) : contextStatus.status === 'error' ? (
                <p className="page-state error">{contextStatus.message}</p>
              ) : (
                <>
                  <TalkContextPanel
                    key={talkId}
                    talkId={talkId}
                    goal={contextGoal}
                    rules={contextRules}
                    setGoal={setContextGoal}
                    setRules={setContextRules}
                    status={contextStatus}
                    setStatus={setContextStatus}
                    goalDraft={goalDraft}
                    setGoalDraft={setGoalDraft}
                    newRuleText={newRuleText}
                    setNewRuleText={setNewRuleText}
                    ruleDrafts={ruleDrafts}
                    setRuleDrafts={setRuleDrafts}
                    canEdit={canEditAgents}
                    onUnauthorized={handleUnauthorized}
                  />

                  <SavedSourcesPanel
                    talkId={talkId}
                    sources={contextSources}
                    setSources={setContextSources}
                    canEdit={canEditAgents}
                    hasVisionNonDocAgent={agents.some(
                      (a) => a.supportsVision && !a.supportsPdfDocuments,
                    )}
                    onUnauthorized={handleUnauthorized}
                  />

                  {/* Drive Resources */}
                  <TalkToolsPanel talkId={talkId} />

                  {contextStatus.status === 'success' &&
                  contextStatus.message ? (
                    <p className="page-state">{contextStatus.message}</p>
                  ) : null}
                </>
              )}
            </section>
          ) : null}

          {currentTab === 'connectors' ? (
            <TalkConnectorsPanel
              talkId={talkId}
              onUnauthorized={handleUnauthorized}
            />
          ) : null}

          {currentTab === 'jobs' ? (
            <TalkJobsPanel
              key={talkId}
              talkId={talkId}
              canEditJobs={canEditJobs}
              agentOptions={jobAgentOptions}
              jobDraft={jobDraft}
              setJobDraft={setJobDraft}
              creatingJob={creatingJob}
              setCreatingJob={setCreatingJob}
              selectedJobId={selectedJobId}
              setSelectedJobId={setSelectedJobId}
              talkJobs={talkJobs}
              setTalkJobs={setTalkJobs}
              talkJobsLoaded={talkJobsLoaded}
              setTalkJobsLoaded={setTalkJobsLoaded}
              selectedJobRuns={selectedJobRuns}
              setSelectedJobRuns={setSelectedJobRuns}
              selectedJobRunsStatus={selectedJobRunsStatus}
              setSelectedJobRunsStatus={setSelectedJobRunsStatus}
              status={talkJobsStatus}
              setStatus={setTalkJobsStatus}
              onUnauthorized={handleUnauthorized}
              onJobRunSettled={handleJobRunSettled}
            />
          ) : null}

          {currentTab === 'runs' ? (
            <TalkRunsPanel
              runHistory={runHistory}
              runContextPanels={runContextPanels}
              messageLookup={messageLookup}
              talkId={talkId}
              handleOpenRunTrigger={handleOpenRunTrigger}
              handleToggleRunContext={handleToggleRunContext}
              handleUnauthorized={handleUnauthorized}
              refreshBrowserRuns={refreshBrowserRuns}
            />
          ) : null}

          {currentTab === 'talk' ? (
            <TalkTabContent
              talkId={talkId}
              splitContainerRef={splitContainerRef}
              splitHandleRef={splitHandleRef}
              docBodyRef={docBodyRef}
              docNarrowShowBtnRef={docNarrowShowBtnRef}
              timelineRef={timelineRef}
              endRef={endRef}
              setMessageElementRef={setMessageElementRef}
              fileInputRef={fileInputRef}
              textareaRef={textareaRef}
              talkContent={talkContent}
              setTalkContent={setTalkContent}
              isNarrowViewport={isNarrowViewport}
              mobilePane={mobilePane}
              setMobilePane={setMobilePane}
              docPaneHidden={docPaneHidden}
              setDocPaneHidden={setDocPaneHidden}
              chatRatio={chatRatio}
              handleResizeHandleKeyDown={handleResizeHandleKeyDown}
              threadState={threadState}
              sortedThreads={sortedThreads}
              editingThreadId={editingThreadId}
              setEditingThreadId={setEditingThreadId}
              activeThreadId={activeThreadId}
              activeThread={activeThread}
              threadMenu={threadMenu}
              menuThread={menuThread}
              handleCreateThread={handleCreateThread}
              handleSearch={handleSearch}
              searchQuery={searchQuery}
              setSearchQuery={setSearchQuery}
              searchLoading={searchLoading}
              searchError={searchError}
              searchResults={searchResults}
              handleSearchResultSelect={handleSearchResultSelect}
              handleThreadSecondaryClick={handleThreadSecondaryClick}
              handleThreadContextMenu={handleThreadContextMenu}
              handleRenameThread={handleRenameThread}
              handleSelectThread={handleSelectThread}
              closeThreadMenu={() => setThreadMenu(null)}
              onRenameMenuThread={(thread) => setEditingThreadId(thread.id)}
              onToggleMenuThreadPin={(thread) => {
                void updateThreadMetadata(thread.id, {
                  pinned: !thread.isPinned,
                }).catch((err) => {
                  setThreadState((current) => ({
                    ...current,
                    error:
                      err instanceof Error
                        ? err.message
                        : 'Failed to update thread.',
                  }));
                });
              }}
              onDeleteMenuThread={(thread) => {
                void handleDeleteThread(thread);
              }}
              handleRenameActiveThread={handleRenameActiveThread}
              openHistoryEditor={openHistoryEditor}
              canEditHistory={canEditHistory}
              activeOrderedProgress={activeOrderedProgress}
              latestOrderedRound={latestOrderedRound}
              handleRetryAgentRun={handleRetryAgentRun}
              retryRunState={retryRunState}
              isSnapshotPending={snapshotQuery.isPending}
              olderMessagesAvailable={olderMessagesAvailable}
              loadingOlderMessages={loadingOlderMessages}
              pageMessages={pageMessages}
              handleLoadOlderMessages={handleLoadOlderMessages}
              talkTimeline={talkTimeline}
              agentsTabHref={agentsTabHref}
              runsById={state.runsById}
              orderedGroupSizesById={orderedGroupSizesById}
              agentLabelById={agentLabelById}
              handleUnauthorized={handleUnauthorized}
              refreshBrowserRuns={refreshBrowserRuns}
              isDenseRound={isDenseRound}
              nowTick={nowTick}
              handleOpenRunHistory={handleOpenRunHistory}
              hasUnreadBelow={state.hasUnreadBelow}
              handleClearUnread={handleClearUnread}
              toolsRefreshKey={toolsRefreshKey}
              handleSend={handleSend}
              ALLOWED_ATTACHMENT_EXTENSIONS={ALLOWED_ATTACHMENT_EXTENSIONS}
              handleFileInputChange={handleFileInputChange}
              GREENFIELD_MESSAGE_ATTACHMENTS_ENABLED={
                GREENFIELD_MESSAGE_ATTACHMENTS_ENABLED
              }
              effectiveAgents={effectiveAgents}
              targetAgentIds={targetAgentIds}
              talkAgentExecutionGuardrailsById={
                talkAgentExecutionGuardrailsById
              }
              selectedGuardrailAgentIds={selectedGuardrailAgentIds}
              handleToggleTarget={handleToggleTarget}
              sendState={state.sendState}
              composerTargetHelp={composerTargetHelp}
              draft={draft}
              TALK_MESSAGE_MAX_CHARS={TALK_MESSAGE_MAX_CHARS}
              composerGuardrailMessage={composerGuardrailMessage}
              mentionState={mentionState}
              mentionOptions={mentionOptions}
              insertMentionOption={insertMentionOption}
              setMentionState={setMentionState}
              handleDraftChange={handleDraftChange}
              handleComposerKeyDown={handleComposerKeyDown}
              contextSources={contextSources}
              activeRound={activeRound}
              hasUnsavedAgentChanges={hasUnsavedAgentChanges}
              pendingAttachments={pendingAttachments}
              handleRemoveAttachment={handleRemoveAttachment}
              handleAttachButtonClick={handleAttachButtonClick}
              canEditAgents={canEditAgents}
              handleCancelRuns={handleCancelRuns}
              cancelState={state.cancelState}
              sendBlockedByGuardrail={sendBlockedByGuardrail}
              historyEditState={historyEditState}
              handleShowDocPane={handleShowDocPane}
              handleHideDocPane={handleHideDocPane}
              handleDocTitleSave={handleDocTitleSave}
              talkContentSaveStatus={talkContentSaveStatus}
              talkContentLoading={talkContentLoading}
              htmlMode={htmlMode}
              setHtmlMode={setHtmlMode}
              talkContentConflict={talkContentConflict}
              setTalkContentConflict={setTalkContentConflict}
              setTalkContentSaveStatus={setTalkContentSaveStatus}
              refetchTalkContent={refetchTalkContent}
              talkContentError={talkContentError}
              htmlSourceDraft={htmlSourceDraft}
              handleHtmlSourceChange={handleHtmlSourceChange}
              handleHtmlSourceSave={handleHtmlSourceSave}
              canEditDoc={canEditDoc}
              talkContentPendingEdits={talkContentPendingEdits}
              setTalkContentPendingEdits={setTalkContentPendingEdits}
              pendingEditStreamingByRunId={pendingEditStreamingByRunId}
              pendingEditInFlight={pendingEditInFlight}
              setPendingEditInFlight={setPendingEditInFlight}
              setTalkContentError={setTalkContentError}
            />
          ) : null}
        </div>
      </div>
      <TalkHistoryEditor
        isOpen={historyEditorOpen}
        messages={pageMessages}
        busy={historyEditState.status === 'saving'}
        errorMessage={
          historyEditorOpen && historyEditState.status === 'error'
            ? historyEditState.message || null
            : null
        }
        onClose={handleCloseHistoryEditor}
        onConfirm={handleDeleteHistoryMessages}
        resolveActorLabel={resolveMessageActorLabel}
      />
      {docModalOpen ? (
        <div
          className="doc-promote-modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="doc-promote-modal-title"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeDocModal();
          }}
        >
          <form className="doc-promote-modal" onSubmit={handleCreateDoc}>
            <h3 id="doc-promote-modal-title">Add a document</h3>
            <label
              className="doc-promote-modal-label"
              htmlFor="doc-promote-modal-input"
            >
              Title
            </label>
            <input
              id="doc-promote-modal-input"
              ref={docModalInputRef}
              type="text"
              className="doc-promote-modal-input"
              value={docModalTitle}
              onChange={(event) => setDocModalTitle(event.target.value)}
              placeholder="Untitled document"
              maxLength={160}
              disabled={docModalSubmitting}
              autoComplete="off"
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault();
                  closeDocModal();
                }
              }}
            />
            <fieldset
              className="doc-promote-modal-format"
              disabled={docModalSubmitting}
            >
              <legend className="doc-promote-modal-label">Format</legend>
              <label className="doc-promote-modal-format-option">
                <input
                  type="radio"
                  name="doc-promote-modal-format"
                  value="markdown"
                  checked={docModalFormat === 'markdown'}
                  onChange={() => setDocModalFormat('markdown')}
                />
                Markdown
              </label>
              <label className="doc-promote-modal-format-option">
                <input
                  type="radio"
                  name="doc-promote-modal-format"
                  value="html"
                  checked={docModalFormat === 'html'}
                  onChange={() => setDocModalFormat('html')}
                />
                HTML
              </label>
            </fieldset>
            {docModalError ? (
              <p className="doc-promote-modal-error" role="alert">
                {docModalError}
              </p>
            ) : null}
            <div className="doc-promote-modal-actions">
              <button
                type="button"
                className="doc-promote-modal-cancel"
                onClick={closeDocModal}
                disabled={docModalSubmitting}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="doc-promote-modal-submit"
                disabled={docModalSubmitting || !docModalTitle.trim()}
              >
                {docModalSubmitting ? 'Creating…' : 'Create document'}
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </section>
  );
}
