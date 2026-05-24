import { FormEvent, useState } from 'react';

import type { WorkspaceChannel } from '../../lib/api';

type TelegramChannelFormProps = {
  mode: 'create' | 'edit';
  initial?: WorkspaceChannel;
  submitting: boolean;
  error: string | null;
  onSubmit: (input: {
    displayName: string;
    config: { bot_id: string; chat_id: string };
    apiKey?: string | null;
    rotateCredential?: boolean;
  }) => void | Promise<void>;
  onCancel: () => void;
};

export function TelegramChannelForm({
  mode,
  initial,
  submitting,
  error,
  onSubmit,
  onCancel,
}: TelegramChannelFormProps): JSX.Element {
  const initialConfig = (initial?.config ?? {}) as Record<string, unknown>;
  const [displayName, setDisplayName] = useState<string>(
    initial?.displayName ?? '',
  );
  const [botId, setBotId] = useState<string>(
    typeof initialConfig.bot_id === 'string' ? initialConfig.bot_id : '',
  );
  const [chatId, setChatId] = useState<string>(
    typeof initialConfig.chat_id === 'string' ? initialConfig.chat_id : '',
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
    const trimmedBot = botId.trim();
    const trimmedChat = chatId.trim();
    if (!trimmedBot || !trimmedChat) return;
    void onSubmit({
      displayName: trimmedName,
      config: { bot_id: trimmedBot, chat_id: trimmedChat },
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
          placeholder="Telegram bot"
          required
          maxLength={200}
        />
      </label>
      <label className="form-field">
        <span className="form-field-label">Bot ID</span>
        <input
          type="text"
          value={botId}
          onChange={(event) => setBotId(event.target.value)}
          placeholder="123456789"
          required
        />
      </label>
      <label className="form-field">
        <span className="form-field-label">Chat ID</span>
        <input
          type="text"
          value={chatId}
          onChange={(event) => setChatId(event.target.value)}
          placeholder="-1001234567890"
          required
        />
      </label>
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
            placeholder="123456:ABC-DEF…"
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
