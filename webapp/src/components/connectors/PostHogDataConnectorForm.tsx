import { FormEvent, useState } from 'react';

import type { WorkspaceDataConnector } from '../../lib/api';

type PostHogDataConnectorFormProps = {
  mode: 'create' | 'edit';
  initial?: WorkspaceDataConnector;
  submitting: boolean;
  error: string | null;
  onSubmit: (input: {
    displayName: string;
    config: { project_id: string; host: string };
    apiKey?: string | null;
    rotateCredential?: boolean;
  }) => void | Promise<void>;
  onCancel: () => void;
};

export function PostHogDataConnectorForm({
  mode,
  initial,
  submitting,
  error,
  onSubmit,
  onCancel,
}: PostHogDataConnectorFormProps): JSX.Element {
  const initialConfig = (initial?.config ?? {}) as Record<string, unknown>;
  const [displayName, setDisplayName] = useState<string>(
    initial?.displayName ?? '',
  );
  const [projectId, setProjectId] = useState<string>(
    typeof initialConfig.project_id === 'string'
      ? initialConfig.project_id
      : '',
  );
  const [host, setHost] = useState<string>(
    typeof initialConfig.host === 'string'
      ? initialConfig.host
      : 'https://us.posthog.com',
  );
  const [apiKey, setApiKey] = useState<string>('');
  const [rotating, setRotating] = useState<boolean>(mode === 'create');

  const editingExisting = mode === 'edit';
  const showCredentialInput = !editingExisting || rotating;

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (submitting) return;
    const trimmedName = displayName.trim();
    const trimmedProject = projectId.trim();
    const trimmedHost = host.trim();
    if (!trimmedName || !trimmedProject || !trimmedHost) return;
    void onSubmit({
      displayName: trimmedName,
      config: { project_id: trimmedProject, host: trimmedHost },
      ...(rotating
        ? { apiKey: apiKey.trim() || null, rotateCredential: true }
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
          placeholder="Project analytics"
          required
          maxLength={200}
        />
      </label>
      <label className="form-field">
        <span className="form-field-label">Project ID</span>
        <input
          type="text"
          value={projectId}
          onChange={(event) => setProjectId(event.target.value)}
          placeholder="12345"
          required
        />
      </label>
      <label className="form-field">
        <span className="form-field-label">Host</span>
        <input
          type="url"
          value={host}
          onChange={(event) => setHost(event.target.value)}
          placeholder="https://us.posthog.com"
          required
        />
      </label>
      <fieldset className="connector-kind-form-credential">
        <legend>API key</legend>
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
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder="phx_…"
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
          {submitting
            ? 'Saving…'
            : mode === 'create'
              ? 'Add data source'
              : 'Save'}
        </button>
      </div>
    </form>
  );
}
