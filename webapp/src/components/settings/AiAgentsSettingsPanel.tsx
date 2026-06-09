import { RegisteredAgentsPanel } from '../RegisteredAgentsPanel';
import type {
  AgentProviderCard,
  ExecutorSettings,
  RegisteredAgent,
} from '../../lib/api';

type AiAgentsSettingsPanelProps = {
  providers: AgentProviderCard[];
  executorSettings: ExecutorSettings;
  agents: RegisteredAgent[];
  mainAgentId: string | null;
  mainAgentDraft: string;
  canManage: boolean;
  busy: boolean;
  workspaceId?: string | null;
  onUnauthorized: () => void;
  onAgentsChanged: (agents: RegisteredAgent[]) => void;
  onMainAgentDraftChange: (agentId: string) => void;
  onSaveMainAgent: () => void;
};

export function AiAgentsSettingsPanel({
  providers,
  executorSettings,
  agents,
  mainAgentId,
  mainAgentDraft,
  canManage,
  busy,
  workspaceId,
  onUnauthorized,
  onAgentsChanged,
  onMainAgentDraftChange,
  onSaveMainAgent,
}: AiAgentsSettingsPanelProps): JSX.Element {
  const selectedMain = agents.find((agent) => agent.id === mainAgentDraft);
  const mainAgentOptions = agents.filter(
    (agent) => agent.enabled || agent.id === mainAgentDraft,
  );

  return (
    <div className="settings-salon-panel settings-agents-panel">
      <section className="settings-agent-summary" aria-label="Agent overview">
        <div>
          <span>Registered agents</span>
          <strong>{agents.length}</strong>
        </div>
        <div>
          <span>Enabled</span>
          <strong>{agents.filter((agent) => agent.enabled).length}</strong>
        </div>
        <div>
          <span>Main agent</span>
          <strong>{selectedMain?.name ?? 'Not set'}</strong>
        </div>
      </section>
      <section className="settings-card">
        <RegisteredAgentsPanel
          providers={providers}
          executorSettings={executorSettings}
          containerRuntimeAvailability="unavailable"
          onUnauthorized={onUnauthorized}
          canManage={canManage}
          mainAgentId={mainAgentId}
          workspaceId={workspaceId}
          onAgentsChanged={onAgentsChanged}
        />
      </section>

      {agents.length > 0 ? (
        <section className="settings-card">
          <h2>Main Agent</h2>
          <p className="settings-copy">
            The main agent is the default participant when a Talk doesn't
            specify one.
          </p>
          <div className="talk-llm-grid">
            <label className="talk-llm-field-span">
              <span>Select main agent</span>
              <select
                value={mainAgentDraft}
                onChange={(event) => onMainAgentDraftChange(event.target.value)}
                disabled={!canManage || busy}
              >
                <option value="" disabled>
                  Choose an agent…
                </option>
                {mainAgentOptions.map((agent) => (
                  <option
                    key={agent.id}
                    value={agent.id}
                    disabled={!agent.enabled}
                  >
                    {agent.name} ({agent.modelId})
                    {agent.enabled ? '' : ' (disabled)'}
                  </option>
                ))}
              </select>
            </label>
            <div className="talk-llm-inline-actions">
              <button
                type="button"
                className="primary-btn"
                onClick={onSaveMainAgent}
                disabled={
                  !canManage ||
                  busy ||
                  !mainAgentDraft ||
                  !selectedMain?.enabled ||
                  mainAgentDraft === mainAgentId
                }
              >
                {busy ? 'Saving…' : 'Set as Main Agent'}
              </button>
            </div>
          </div>
          {selectedMain && !selectedMain.executionPreview.ready ? (
            <p className="talk-llm-meta error-text">
              {selectedMain.executionPreview.message}
            </p>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
