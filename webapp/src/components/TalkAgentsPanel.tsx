import { useState, type CSSProperties } from 'react';
import { Link } from 'react-router-dom';

import type { RegisteredAgent, TalkAgent } from '../lib/api';
import {
  TALK_AGENT_ROLE_OPTIONS,
  formatTalkRole,
  type AgentCreationDraft,
} from '../lib/talkAgents';
import { CTIcon } from '../salon';

type AgentSaveState = {
  status: 'idle' | 'saving' | 'error' | 'success';
  message?: string;
};

type TalkAgentsPanelProps = {
  agentDrafts: TalkAgent[];
  agentState: AgentSaveState;
  agentsCatalogError: string | null;
  registeredAgentsCatalog: RegisteredAgent[];
  canEditAgents: boolean;
  hasUnsavedAgentChanges: boolean;
  manageAgentsHref: string;
  showPanelHeader?: boolean;
  handleSetPrimaryAgent: (agentId: string) => void;
  handleRemoveAgent: (agentId: string) => void;
  handleAddAgent: (draft?: AgentCreationDraft) => void;
  handleSaveAgents: () => void;
};

function coerceTalkRole(role: string | null | undefined): TalkAgent['role'] {
  return TALK_AGENT_ROLE_OPTIONS.includes(role as TalkAgent['role'])
    ? (role as TalkAgent['role'])
    : 'assistant';
}

function buildInitials(name: string): string {
  const words = name
    .replace(/[^a-zA-Z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return 'AI';
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return `${words[0]![0]}${words[1]![0]}`.toUpperCase();
}

function agentDisplayName(
  agent: TalkAgent,
  registeredAgent: RegisteredAgent | undefined,
): string {
  return registeredAgent?.name || agent.nickname || 'Unknown agent';
}

function agentModelLabel(
  agent: TalkAgent,
  registeredAgent: RegisteredAgent | undefined,
): string {
  return (
    registeredAgent?.modelId ||
    agent.modelDisplayName ||
    agent.modelId ||
    'Model pending'
  );
}

function agentAccent(role: TalkAgent['role']): string {
  switch (role) {
    case 'critic':
    case 'devils-advocate':
      return '#8E3B59';
    case 'analyst':
    case 'synthesizer':
      return '#3F6B5C';
    case 'editor':
      return '#3D5688';
    case 'strategist':
      return '#C8643A';
    default:
      return '#C8643A';
  }
}

function buildAgentDraft(agent: RegisteredAgent): AgentCreationDraft {
  return {
    sourceKind: 'provider',
    providerId: agent.providerId,
    modelId: agent.id,
    role: coerceTalkRole(agent.personaRole),
  };
}

export function TalkAgentsPanel({
  agentDrafts,
  agentState,
  agentsCatalogError,
  registeredAgentsCatalog,
  canEditAgents,
  hasUnsavedAgentChanges,
  manageAgentsHref,
  showPanelHeader = true,
  handleSetPrimaryAgent,
  handleRemoveAgent,
  handleAddAgent,
  handleSaveAgents,
}: TalkAgentsPanelProps): JSX.Element {
  const assignedAgentIds = new Set(agentDrafts.map((agent) => agent.id));
  const availableRegisteredAgents = registeredAgentsCatalog.filter(
    (agent) => agent.enabled && !assignedAgentIds.has(agent.id),
  );
  const registeredAgentsById = new Map(
    registeredAgentsCatalog.map((agent) => [agent.id, agent] as const),
  );
  const saving = agentState.status === 'saving';
  const [addMenuOpen, setAddMenuOpen] = useState(false);

  return (
    <section
      className="talk-tab-panel talk-room-panel"
      aria-label="Talk agents"
    >
      {showPanelHeader ? (
        <header className="agents-panel-header talk-room-panel-header">
          <div>
            <p className="talk-room-kicker">Speaking order</p>
            <h2>The Room</h2>
          </div>
          <Link className="talk-room-manage-link" to={manageAgentsHref}>
            Manage AI Agents
          </Link>
        </header>
      ) : (
        <div className="talk-room-panel-toolbar">
          <p className="talk-room-kicker">Speaking order</p>
          <Link className="talk-room-manage-link" to={manageAgentsHref}>
            Manage AI Agents
          </Link>
        </div>
      )}

      <div
        className="talk-room-list"
        role="list"
        aria-label="Agents in this talk"
      >
        {agentDrafts.map((agent, index) => {
          const registeredAgent = registeredAgentsById.get(agent.id);
          const displayName = agentDisplayName(agent, registeredAgent);
          const roleLabel = formatTalkRole(agent.role);
          const healthLabel =
            agent.health === 'ready'
              ? 'Ready'
              : agent.health === 'invalid'
                ? 'Needs setup'
                : 'Pending';

          return (
            <article
              key={agent.id}
              className="talk-room-agent-card"
              style={
                {
                  '--talk-room-agent-accent': agentAccent(agent.role),
                } as CSSProperties
              }
              role="listitem"
              aria-label={`${displayName}, ${roleLabel}`}
            >
              <span
                className="talk-room-order"
                aria-label={`Order ${index + 1}`}
              >
                {index + 1}
              </span>
              <span className="talk-room-avatar" aria-hidden="true">
                {buildInitials(displayName)}
              </span>
              <div className="talk-room-agent-main">
                <div className="talk-room-agent-title">
                  <strong>{displayName}</strong>
                  <span className="talk-room-role-badge">{roleLabel}</span>
                </div>
                <div className="talk-room-agent-meta">
                  <span>{agentModelLabel(agent, registeredAgent)}</span>
                  <span>{healthLabel}</span>
                </div>
                {registeredAgent?.description ? (
                  <p className="talk-room-agent-description">
                    {registeredAgent.description}
                  </p>
                ) : null}
              </div>
              <div className="talk-room-agent-actions">
                <label className="policy-primary-toggle talk-room-primary-toggle">
                  <input
                    type="radio"
                    name="primary-talk-agent"
                    checked={agent.isPrimary}
                    onChange={() => handleSetPrimaryAgent(agent.id)}
                    disabled={!canEditAgents || saving}
                  />
                  <span>Primary</span>
                </label>
                <button
                  type="button"
                  className="talk-room-text-button"
                  onClick={() => handleRemoveAgent(agent.id)}
                  disabled={!canEditAgents || saving || agentDrafts.length <= 1}
                >
                  Remove
                </button>
              </div>
            </article>
          );
        })}
      </div>

      <div className="talk-room-add-card">
        {availableRegisteredAgents.length === 0 ? (
          <div className="talk-room-add-empty">
            <span className="talk-room-add-icon" aria-hidden="true">
              <CTIcon name="check" size={13} strokeWidth={1.8} />
            </span>
            <span>Every registered agent is already in this room.</span>
          </div>
        ) : (
          <button
            type="button"
            className="talk-room-add-trigger"
            aria-expanded={addMenuOpen}
            onClick={() => setAddMenuOpen((open) => !open)}
            disabled={!canEditAgents || saving}
          >
            <span className="talk-room-add-icon" aria-hidden="true">
              <CTIcon name="plus" size={13} strokeWidth={1.8} />
            </span>
            <span className="talk-room-add-label">
              Add an agent to the room
            </span>
            <span className="talk-room-available-count">
              {availableRegisteredAgents.length} available
            </span>
            <CTIcon
              name={addMenuOpen ? 'chevron-d' : 'chevron-r'}
              size={13}
              strokeWidth={1.8}
            />
          </button>
        )}
        {addMenuOpen && availableRegisteredAgents.length > 0 ? (
          <div
            className="talk-room-add-options"
            role="list"
            aria-label="Available registered agents"
          >
            {availableRegisteredAgents.map((agent) => {
              const role = coerceTalkRole(agent.personaRole);
              const roleLabel = formatTalkRole(role);
              return (
                <div key={agent.id} role="listitem">
                  <button
                    type="button"
                    className="talk-room-add-option"
                    aria-label={`Add ${agent.name} to room`}
                    style={
                      {
                        '--talk-room-agent-accent': agentAccent(role),
                      } as CSSProperties
                    }
                    onClick={() => {
                      handleAddAgent(buildAgentDraft(agent));
                      setAddMenuOpen(false);
                    }}
                    disabled={!canEditAgents || saving}
                  >
                    <span className="talk-room-avatar" aria-hidden="true">
                      {buildInitials(agent.name)}
                    </span>
                    <span className="talk-room-add-option-main">
                      <span className="talk-room-agent-title">
                        <strong>{agent.name}</strong>
                        <span className="talk-room-role-badge">
                          {roleLabel}
                        </span>
                      </span>
                      <span className="talk-room-add-option-model">
                        {agent.modelId || 'Model pending'}
                      </span>
                    </span>
                    <span className="talk-room-add-option-plus" aria-hidden>
                      <CTIcon name="plus" size={13} strokeWidth={2.1} />
                    </span>
                  </button>
                </div>
              );
            })}
            <Link className="talk-room-add-manage-link" to={manageAgentsHref}>
              Manage all agents
              <CTIcon name="arrow" size={11} strokeWidth={1.8} />
            </Link>
          </div>
        ) : null}
      </div>

      <div className="talk-room-save-strip">
        <button
          type="button"
          className="talk-room-save-button"
          onClick={handleSaveAgents}
          disabled={!canEditAgents || saving || !hasUnsavedAgentChanges}
        >
          <CTIcon name="bolt" size={12} strokeWidth={1.7} />
          {saving ? 'Saving...' : 'Save room'}
        </button>
      </div>

      {agentsCatalogError ? (
        <div className="inline-banner inline-banner-error" role="alert">
          {agentsCatalogError}
        </div>
      ) : null}
      {agentState.status === 'error' ? (
        <div className="inline-banner inline-banner-error" role="alert">
          {agentState.message}
        </div>
      ) : null}
      {agentState.status === 'success' ? (
        <div className="inline-banner inline-banner-success" role="status">
          {agentState.message}
        </div>
      ) : null}
    </section>
  );
}
