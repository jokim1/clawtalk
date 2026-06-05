import type { Dispatch, SetStateAction } from 'react';
import { Link } from 'react-router-dom';

import type { RegisteredAgent, TalkAgent } from '../lib/api';
import {
  TALK_AGENT_ROLE_OPTIONS,
  formatTalkRole,
  type AgentCreationDraft,
} from '../lib/talkAgents';

type AgentSaveState = {
  status: 'idle' | 'saving' | 'error' | 'success';
  message?: string;
};

type TalkAgentsPanelProps = {
  agentDrafts: TalkAgent[];
  setAgentDrafts: Dispatch<SetStateAction<TalkAgent[]>>;
  newAgentDraft: AgentCreationDraft;
  setNewAgentDraft: Dispatch<SetStateAction<AgentCreationDraft>>;
  agentState: AgentSaveState;
  setAgentState: Dispatch<SetStateAction<AgentSaveState>>;
  agentsCatalogError: string | null;
  registeredAgentsCatalog: RegisteredAgent[];
  canEditAgents: boolean;
  hasPendingFooterAgentSelection: boolean;
  manageAgentsHref: string;
  handleAgentNicknameChange: (agentId: string, nickname: string) => void;
  handleAgentRoleChange: (agentId: string, role: TalkAgent['role']) => void;
  handleSetPrimaryAgent: (agentId: string) => void;
  handleResetNickname: (agentId: string) => void;
  handleRemoveAgent: (agentId: string) => void;
  handleAddAgent: () => void;
  handleSaveAgents: () => void;
};

/**
 * Presentational Talk Agents tab (registered-agent roster editor + add-agent
 * footer). All mutation-written state (agentDrafts, the add-agent footer
 * draft, the save status) is page-owned and threaded in — this tab unmounts on
 * every tab switch, so panel-local copies would orphan an in-flight save
 * (cf. TalkContextPanel / TalkJobsPanel). The page keeps the handlers because
 * they reach page-only state (targetAgentIds, the registered-agent catalog,
 * nickname helpers).
 */
export function TalkAgentsPanel({
  agentDrafts,
  setAgentDrafts,
  newAgentDraft,
  setNewAgentDraft,
  agentState,
  setAgentState,
  agentsCatalogError,
  registeredAgentsCatalog,
  canEditAgents,
  hasPendingFooterAgentSelection,
  manageAgentsHref,
  handleAgentNicknameChange,
  handleAgentRoleChange,
  handleSetPrimaryAgent,
  handleResetNickname,
  handleRemoveAgent,
  handleAddAgent,
  handleSaveAgents,
}: TalkAgentsPanelProps): JSX.Element {
  return (
    <section className="talk-tab-panel" aria-label="Talk agents">
      <div className="agents-panel-header">
        <h2>Agents</h2>
        <Link className="secondary-btn" to={manageAgentsHref}>
          Manage AI Agents
        </Link>
      </div>
      <p className="policy-muted">
        Nicknames are local to this talk. The primary agent responds to normal
        user messages by default.
      </p>
      {agentDrafts.map((agent) => (
        <div key={agent.id} className="agent-editor-card">
          <label>
            <span>Registered Agent</span>
            <select
              value={agent.id}
              onChange={(event) => {
                const regAgent = registeredAgentsCatalog.find(
                  (ra) => ra.id === event.target.value,
                );
                if (!regAgent) return;
                setAgentDrafts((current) =>
                  current.map((a) =>
                    a.id === agent.id
                      ? {
                          ...a,
                          id: regAgent.id,
                          sourceKind: 'provider',
                          providerId: regAgent.providerId,
                          modelId: regAgent.modelId,
                          modelDisplayName: null,
                          nickname:
                            a.nicknameMode === 'auto'
                              ? regAgent.name
                              : a.nickname,
                          health: 'ready',
                        }
                      : a,
                  ),
                );
                setAgentState({ status: 'idle' });
              }}
              disabled={!canEditAgents || agentState.status === 'saving'}
            >
              <option
                value={agent.id}
                disabled={
                  !registeredAgentsCatalog.some((ra) => ra.id === agent.id)
                }
              >
                {registeredAgentsCatalog.find((ra) => ra.id === agent.id)
                  ?.name ||
                  agent.nickname ||
                  'Unknown agent'}
              </option>
              {registeredAgentsCatalog
                .filter(
                  (ra) =>
                    ra.enabled &&
                    ra.id !== agent.id &&
                    !agentDrafts.some((d) => d.id === ra.id),
                )
                .map((ra) => (
                  <option key={ra.id} value={ra.id}>
                    {ra.name}
                    {ra.personaRole ? ` · ${ra.personaRole}` : ''} ({ra.modelId}
                    )
                  </option>
                ))}
            </select>
          </label>
          {(() => {
            const persona = registeredAgentsCatalog.find(
              (ra) => ra.id === agent.id,
            );
            return persona?.description ? (
              <p className="talk-llm-meta talk-agent-persona-blurb">
                {persona.description}
              </p>
            ) : null;
          })()}
          <label>
            <span>Nickname</span>
            <input
              type="text"
              value={agent.nickname}
              onChange={(event) =>
                handleAgentNicknameChange(agent.id, event.target.value)
              }
              disabled={!canEditAgents || agentState.status === 'saving'}
            />
          </label>
          <label>
            <span>Role</span>
            <select
              value={agent.role}
              onChange={(event) =>
                handleAgentRoleChange(
                  agent.id,
                  event.target.value as TalkAgent['role'],
                )
              }
              disabled={!canEditAgents || agentState.status === 'saving'}
            >
              {TALK_AGENT_ROLE_OPTIONS.map((role) => (
                <option key={role} value={role}>
                  {formatTalkRole(role)}
                </option>
              ))}
            </select>
          </label>
          <div className="agent-editor-actions">
            <label className="policy-primary-toggle">
              <input
                type="radio"
                name="primary-talk-agent"
                checked={agent.isPrimary}
                onChange={() => handleSetPrimaryAgent(agent.id)}
                disabled={!canEditAgents || agentState.status === 'saving'}
              />
              <span>Primary Agent</span>
            </label>
            <button
              type="button"
              className="secondary-btn"
              onClick={() => handleResetNickname(agent.id)}
              disabled={!canEditAgents || agentState.status === 'saving'}
            >
              Reset name
            </button>
            <button
              type="button"
              className="secondary-btn"
              onClick={() => handleRemoveAgent(agent.id)}
              disabled={
                !canEditAgents ||
                agentState.status === 'saving' ||
                agentDrafts.length <= 1
              }
            >
              Remove
            </button>
          </div>
        </div>
      ))}

      <div className="agent-editor-footer">
        <label>
          <span>Agent</span>
          <select
            value={newAgentDraft.modelId}
            onChange={(event) => {
              const ra = registeredAgentsCatalog.find(
                (a) => a.id === event.target.value,
              );
              if (!ra) return;
              setNewAgentDraft({
                sourceKind: 'provider',
                providerId: ra.providerId,
                modelId: ra.id,
                role: (ra.personaRole as TalkAgent['role']) || 'assistant',
              });
            }}
            disabled={!canEditAgents || agentState.status === 'saving'}
          >
            <option value="" disabled>
              Choose a registered agent…
            </option>
            {registeredAgentsCatalog
              .filter(
                (ra) => ra.enabled && !agentDrafts.some((d) => d.id === ra.id),
              )
              .map((ra) => (
                <option key={ra.id} value={ra.id}>
                  {ra.name}
                  {ra.personaRole ? ` · ${ra.personaRole}` : ''} ({ra.modelId})
                </option>
              ))}
          </select>
        </label>
        <label>
          <span>Role</span>
          <select
            value={newAgentDraft.role}
            onChange={(event) =>
              setNewAgentDraft((current) => ({
                ...current,
                role: event.target.value as TalkAgent['role'],
              }))
            }
            disabled={!canEditAgents || agentState.status === 'saving'}
          >
            {TALK_AGENT_ROLE_OPTIONS.map((role) => (
              <option key={role} value={role}>
                {formatTalkRole(role)}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="secondary-btn"
          onClick={handleAddAgent}
          disabled={
            !canEditAgents ||
            agentState.status === 'saving' ||
            !newAgentDraft.modelId
          }
        >
          Add Agent
        </button>
        <button
          type="button"
          className="secondary-btn"
          onClick={handleSaveAgents}
          disabled={!canEditAgents || agentState.status === 'saving'}
        >
          {agentState.status === 'saving'
            ? 'Saving…'
            : hasPendingFooterAgentSelection
              ? 'Add + Save Agents'
              : 'Save Agents'}
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
