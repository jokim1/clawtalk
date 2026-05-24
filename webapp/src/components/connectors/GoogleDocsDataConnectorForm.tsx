import { FormEvent, useState } from 'react';

import type { WorkspaceDataConnector } from '../../lib/api';

type GoogleDocsDataConnectorFormProps = {
  mode: 'create' | 'edit';
  initial?: WorkspaceDataConnector;
  submitting: boolean;
  error: string | null;
  onSubmit: (input: {
    displayName: string;
    config: { folder_id?: string };
  }) => void | Promise<void>;
  onCancel: () => void;
};

export function GoogleDocsDataConnectorForm({
  mode,
  initial,
  submitting,
  error,
  onSubmit,
  onCancel,
}: GoogleDocsDataConnectorFormProps): JSX.Element {
  const initialConfig = (initial?.config ?? {}) as Record<string, unknown>;
  const [displayName, setDisplayName] = useState<string>(
    initial?.displayName ?? '',
  );
  const [folderId, setFolderId] = useState<string>(
    typeof initialConfig.folder_id === 'string' ? initialConfig.folder_id : '',
  );

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (submitting) return;
    const trimmedName = displayName.trim();
    if (!trimmedName) return;
    const trimmedFolder = folderId.trim();
    void onSubmit({
      displayName: trimmedName,
      config: trimmedFolder ? { folder_id: trimmedFolder } : {},
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
          placeholder="Team docs"
          required
          maxLength={200}
        />
      </label>
      <label className="form-field">
        <span className="form-field-label">Folder ID (optional)</span>
        <input
          type="text"
          value={folderId}
          onChange={(event) => setFolderId(event.target.value)}
          placeholder="Google Drive folder ID"
        />
      </label>
      <p className="form-field-help">
        Folder picker arrives in a follow-up PR. For now, paste a folder ID from
        the Drive URL.
      </p>
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
