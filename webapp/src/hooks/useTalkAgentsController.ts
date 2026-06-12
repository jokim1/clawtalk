import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';

import type { JobAgentOption } from '../components/TalkJobsPanel';
import {
  getAiAgents,
  listRegisteredAgents,
  updateTalkAgents,
  UnauthorizedError,
  type AiAgentsPageData,
  type RegisteredAgent,
  type TalkAgent,
} from '../lib/api';
import {
  buildAgentLabel,
  type AgentCreationDraft,
  type TalkAgentExecutionGuardrail,
} from '../lib/talkAgents';

type TalkDetailPageKind = 'loading' | 'ready' | 'unavailable' | 'error';

type AgentSaveState = {
  status: 'idle' | 'saving' | 'error' | 'success';
  message?: string;
};

type UseTalkAgentsControllerOptions = {
  pageKind: TalkDetailPageKind;
  pageTalkId: string | null;
  activeTalkWorkspaceId: string | null;
  canEditAgents: boolean;
  onUnauthorized: () => void;
};

type MaterializedFooterAgent = {
  nextAgents: TalkAgent[];
  nextDraft: AgentCreationDraft;
  added: boolean;
  error: string | null;
};

const INITIAL_NEW_AGENT_DRAFT: AgentCreationDraft = {
  sourceKind: 'claude_default',
  providerId: null,
  modelId: '',
  role: 'assistant',
};

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

function buildNewAgentDraft(
  _aiAgents: AiAgentsPageData | null,
): AgentCreationDraft {
  // modelId is overloaded to store the selected registered agent ID.
  // Start empty so the dropdown shows the add-agent placeholder and the
  // Add button is disabled until the user selects one.
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
  _agent: TalkAgent,
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

export function useTalkAgentsController({
  pageKind,
  pageTalkId,
  activeTalkWorkspaceId,
  canEditAgents,
  onUnauthorized,
}: UseTalkAgentsControllerOptions): {
  agents: TalkAgent[];
  agentDrafts: TalkAgent[];
  setAgentDrafts: Dispatch<SetStateAction<TalkAgent[]>>;
  newAgentDraft: AgentCreationDraft;
  setNewAgentDraft: Dispatch<SetStateAction<AgentCreationDraft>>;
  agentState: AgentSaveState;
  setAgentState: Dispatch<SetStateAction<AgentSaveState>>;
  agentsCatalogError: string | null;
  registeredAgentsCatalog: RegisteredAgent[];
  targetAgentIds: string[];
  effectiveAgents: TalkAgent[];
  jobAgentOptions: JobAgentOption[];
  hasPendingFooterAgentSelection: boolean;
  hasUnsavedAgentChanges: boolean;
  talkAgentExecutionGuardrailsById: Record<
    string,
    TalkAgentExecutionGuardrail
  >;
  agentLabelById: Record<string, string>;
  selectedTargetAgentCount: number;
  selectedGuardrailAgentIds: Set<string>;
  composerGuardrailMessage: string | null;
  sendBlockedByGuardrail: boolean;
  hasVisionNonDocAgent: boolean;
  resetTalkAgents: () => void;
  hydrateTalkAgents: (talkAgents: TalkAgent[]) => void;
  toggleTargetAgent: (agentId: string) => void;
  handleAgentNicknameChange: (agentId: string, nickname: string) => void;
  handleAgentRoleChange: (agentId: string, role: TalkAgent['role']) => void;
  handleSetPrimaryAgent: (agentId: string) => void;
  handleResetNickname: (agentId: string) => void;
  handleRemoveAgent: (agentId: string) => void;
  handleAddAgent: (draft?: AgentCreationDraft) => void;
  handleSaveAgents: () => Promise<void>;
} {
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
  const [newAgentDraft, setNewAgentDraft] = useState<AgentCreationDraft>(
    INITIAL_NEW_AGENT_DRAFT,
  );
  const [agentState, setAgentState] = useState<AgentSaveState>({
    status: 'idle',
  });

  const resetTalkAgents = useCallback(() => {
    setAgents([]);
    setAgentDrafts([]);
    setTargetAgentIds([]);
    setAgentsCatalogError(null);
    setAgentState({ status: 'idle' });
  }, []);

  const hydrateTalkAgents = useCallback((talkAgents: TalkAgent[]) => {
    setAgents(talkAgents);
    setAgentDrafts(talkAgents);
    setTargetAgentIds(buildTargetSelection(talkAgents, []));
  }, []);

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
          onUnauthorized();
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
  }, [activeTalkWorkspaceId, onUnauthorized, pageKind]);

  const jobAgentOptions = useMemo<JobAgentOption[]>(
    () =>
      agents.map((agent) => ({
        id: agent.id,
        label: buildAgentLabel(agent),
        isPrimary: agent.isPrimary,
      })),
    [agents],
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

    return null;
  }, [
    selectedUnavailableAgents,
    talkAgentExecutionGuardrailsById,
  ]);
  const selectedGuardrailAgentIds = useMemo(
    () => new Set(selectedUnavailableAgents.map((agent) => agent.id)),
    [selectedUnavailableAgents],
  );
  const sendBlockedByGuardrail = Boolean(composerGuardrailMessage);
  const hasVisionNonDocAgent = useMemo(
    () =>
      agents.some((agent) => agent.supportsVision && !agent.supportsPdfDocuments),
    [agents],
  );

  const toggleTargetAgent = useCallback((agentId: string) => {
    setTargetAgentIds((current) => {
      const selected = current.includes(agentId);
      if (selected) {
        if (current.length === 1) return current;
        return current.filter((id) => id !== agentId);
      }
      return [...current, agentId];
    });
  }, []);

  const handleAgentNicknameChange = useCallback(
    (agentId: string, nickname: string) => {
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
    },
    [],
  );

  const handleResetNickname = useCallback(
    (agentId: string) => {
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
    },
    [aiAgentsData, registeredAgentsCatalog],
  );

  const handleAgentRoleChange = useCallback(
    (agentId: string, role: TalkAgent['role']) => {
      setAgentDrafts((current) =>
        current.map((agent) =>
          agent.id === agentId ? { ...agent, role } : agent,
        ),
      );
      setAgentState({ status: 'idle' });
    },
    [],
  );

  const handleSetPrimaryAgent = useCallback((agentId: string) => {
    setAgentDrafts((current) =>
      current.map((agent) => ({
        ...agent,
        isPrimary: agent.id === agentId,
      })),
    );
    setAgentState({ status: 'idle' });
  }, []);

  const handleRemoveAgent = useCallback((agentId: string) => {
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
  }, []);

  const materializePendingFooterAgent = useCallback(
    (
      currentDrafts: TalkAgent[],
      draftOverride?: AgentCreationDraft,
    ): MaterializedFooterAgent => {
      const activeDraft = draftOverride ?? newAgentDraft;
      const selectedAgentId = activeDraft.modelId.trim();
      if (!selectedAgentId) {
        return {
          nextAgents: currentDrafts,
          nextDraft: activeDraft,
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
          nextDraft: activeDraft,
          added: false,
          error:
            'Selected registered agent is no longer available. Refresh and try again.',
        };
      }

      if (currentDrafts.some((agent) => agent.id === regAgent.id)) {
        return {
          nextAgents: currentDrafts,
          nextDraft: activeDraft,
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
            role: activeDraft.role,
            isPrimary: false,
            displayOrder: currentDrafts.length,
            health: 'ready',
            providerId: regAgent.providerId,
            modelId: regAgent.modelId,
            modelDisplayName: null,
            // Capabilities are resolved server-side; an unsaved draft defaults
            // to false. Drafts do not drive the render-pages affordance; that
            // reads the persisted `agents` list, not `agentDrafts`.
            supportsVision: false,
            supportsPdfDocuments: false,
          },
        ],
        nextDraft: {
          ...activeDraft,
          modelId: '',
          providerId: null,
        },
        added: true,
        error: null,
      };
    },
    [newAgentDraft, registeredAgentsCatalog],
  );

  const handleAddAgent = useCallback((draft?: AgentCreationDraft) => {
    const materialized = materializePendingFooterAgent(agentDrafts, draft);
    if (materialized.error) {
      setAgentState({ status: 'error', message: materialized.error });
      return;
    }
    if (!materialized.added) return;
    setAgentDrafts(materialized.nextAgents);
    setNewAgentDraft(materialized.nextDraft);
    setAgentState({ status: 'idle' });
  }, [agentDrafts, materializePendingFooterAgent]);

  const handleSaveAgents = useCallback(async () => {
    if (pageKind !== 'ready' || !pageTalkId || !canEditAgents) return;
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
        talkId: pageTalkId,
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
        onUnauthorized();
        return;
      }
      setAgentState({
        status: 'error',
        message:
          err instanceof Error ? err.message : 'Failed to update talk agents',
      });
    }
  }, [
    agentDrafts,
    canEditAgents,
    materializePendingFooterAgent,
    onUnauthorized,
    pageKind,
    pageTalkId,
  ]);

  return {
    agents,
    agentDrafts,
    setAgentDrafts,
    newAgentDraft,
    setNewAgentDraft,
    agentState,
    setAgentState,
    agentsCatalogError,
    registeredAgentsCatalog,
    targetAgentIds,
    effectiveAgents,
    jobAgentOptions,
    hasPendingFooterAgentSelection,
    hasUnsavedAgentChanges,
    talkAgentExecutionGuardrailsById,
    agentLabelById,
    selectedTargetAgentCount: selectedTargetAgents.length,
    selectedGuardrailAgentIds,
    composerGuardrailMessage,
    sendBlockedByGuardrail,
    hasVisionNonDocAgent,
    resetTalkAgents,
    hydrateTalkAgents,
    toggleTargetAgent,
    handleAgentNicknameChange,
    handleAgentRoleChange,
    handleSetPrimaryAgent,
    handleResetNickname,
    handleRemoveAgent,
    handleAddAgent,
    handleSaveAgents,
  };
}
