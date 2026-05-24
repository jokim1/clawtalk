import { FormEvent, useState } from 'react';

import type { WorkspaceChannel } from '../../lib/api';

type SlackChannelFormProps = {
  mode: 'create' | 'edit';
  initial?: WorkspaceChannel;
  submitting: boolean;
  error: string | null;
  onSubmit: (input: {
    displayName: string;
    config: { workspace_id: string; channel_id: string };
    apiKey?: string | null;
    rotateCredential?: boolean;
  }) => void | Promise<void>;
  onCancel: () => void;
};

export function SlackChannelForm({
  mode,
  initial,
  submitting,
  error,
  onSubmit,
  onCancel,
}: SlackChannelFormProps): JSX.Element {
  const initialConfig = (initial?.config ?? {}) as Record<string, unknown>;
  const [displayName, setDisplayName] = useState<string>(
    initial?.displayName ?? '',
  );
  const [workspaceId, setWorkspaceId] = useState<string>(
    typeof initialConfig.workspace_id === 'string'
      ? initialConfig.workspace_id
      : '',
  );
  const [channelId, setChannelId] = useState<string>(
    typeof initialConfig.channel_id === 'string'
      ? initialConfig.channel_id
      : '',
  );
  const [botToken, setBotToken] = useState<string>('');
  const [rotating, setRotating] = useState<boolean>(mode === 'create');

  const editingExisting = mode === 'edit';
  const showCredentialInput = !editingExisting || rotating;

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (submitting) return;
    const trimmedName = displayName.trim();
    if (!trimmedName) return;
    const trimmedWorkspace = workspaceId.trim();
    const trimmedChannel = channelId.trim();
    if (!trimmedWorkspace || !trimmedChannel) return;
    void onSubmit({
      displayName: trimmedName,
      config: {
        workspace_id: trimmedWorkspace,
        channel_id: trimmedChannel,
      },
      ...(rotating
        ? { apiKey: botToken.trim() || null, rotateCredential: true }
        : {}),
    });
  }

  return (
    <form className="connector-kind-form" onSubmit={handleSubmit}>
      <label className="form-field">
        <span className="form-field-label">Display name</span>
        <input
          type="text"
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
          placeholder="Engineering Slack"
          required
          maxLength={200}
        />
      </label>
      <label className="form-field">
        <span className="form-field-label">Workspace ID</span>
        <input
          type="text"
          value={workspaceId}
          onChange={(event) => setWorkspaceId(event.target.value)}
          placeholder="T01ABCDE"
          required
        />
      </label>
      <label className="form-field">
        <span className="form-field-label">Channel ID</span>
        <input
          type="text"
          value={channelId}
          onChange={(event) => setChannelId(event.target.value)}
          placeholder="C01ABCDE"
          required
        />
      </label>
      <p className="form-field-help">
        Find your workspace ID at api.slack.com/methods/team.info; find the
        channel ID by right-clicking a channel → Copy link.
      </p>
      <fieldset className="connector-kind-form-credential">
        <legend>Bot token</legend>
        {editingExisting && initial?.hasCredential && !rotating ? (
          <div className="connector-kind-form-credential-row">
            <code aria-hidden="true">••••••••</code>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                const confirmed = window.confirm(
                  `Replacing credential for ${initial?.displayName}. The previous credential will be lost.`,
                );
                if (!confirmed) return;
                setRotating(true);
              }}
            >
              Rotate
            </button>
          </div>
        ) : null}
        {showCredentialInput ? (
          <input
            type="password"
            value={botToken}
            onChange={(event) => setBotToken(event.target.value)}
            placeholder="xoxb-…"
            autoComplete="off"
          />
        ) : null}
      </fieldset>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="form-actions">
        <button
          type="button"
          className="btn btn-secondary"
          onClick={onCancel}
          disabled={submitting}
        >
          Cancel
        </button>
        <button type="submit" className="btn btn-primary" disabled={submitting}>
          {submitting ? 'Saving…' : mode === 'create' ? 'Add channel' : 'Save'}
        </button>
      </div>
    </form>
  );
}
