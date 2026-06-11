import { useEffect, useState } from 'react';

import {
  ApiError,
  type SessionUser,
  UnauthorizedError,
  updateSessionMe,
} from '../../lib/api';
import { getUserAvatarColor, getUserInitials } from '../shell/userAvatar';

type ProfileSettingsPanelProps = {
  user: SessionUser;
  onUnauthorized: () => void;
  onUserUpdated: (user: SessionUser) => void;
};

function formatProfileDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.valueOf())) return iso;
  return date.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

function formatRole(role: string): string {
  switch (role) {
    case 'owner':
      return 'Owner';
    case 'admin':
      return 'Admin';
    case 'member':
      return 'Member';
    default:
      return role;
  }
}

function roleDescription(role: string): string {
  switch (role) {
    case 'owner':
      return 'Full access to all settings and billing.';
    case 'admin':
      return 'Can manage agents, connectors, and settings.';
    case 'member':
      return 'Can create and participate in talks.';
    default:
      return '';
  }
}

function deriveProfileHandle(user: SessionUser): string {
  const source = user.displayName.trim() || user.email.split('@')[0] || 'user';
  const handle = source
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '.')
    .replace(/^\.+|\.+$/g, '')
    .slice(0, 28);
  return `@${handle || 'user'}`;
}

export function ProfileSettingsPanel({
  user,
  onUnauthorized,
  onUserUpdated,
}: ProfileSettingsPanelProps): JSX.Element {
  const [nameDraft, setNameDraft] = useState(user.displayName);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    setNameDraft(user.displayName);
  }, [user.displayName]);

  const hasNameChange =
    nameDraft.trim() !== '' && nameDraft.trim() !== user.displayName;

  const handleSave = async (): Promise<void> => {
    if (!hasNameChange) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const updated = await updateSessionMe({
        workspaceId: user.currentWorkspaceId,
        displayName: nameDraft.trim(),
      });
      onUserUpdated(updated);
      setNotice('Profile updated.');
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      setError(
        err instanceof ApiError ? err.message : 'Failed to update profile.',
      );
    } finally {
      setSaving(false);
    }
  };

  const initials = getUserInitials(user.displayName);
  const gradient = getUserAvatarColor(user.id);
  const currentWorkspace =
    user.workspaces?.find(
      (workspace) => workspace.id === user.currentWorkspaceId,
    )?.name ?? 'Workspace';
  const handle = deriveProfileHandle(user);

  return (
    <div className="settings-salon-panel settings-profile-panel">
      {error ? (
        <div className="settings-banner settings-banner-error" role="alert">
          {error}
        </div>
      ) : null}
      {notice ? (
        <div className="settings-banner settings-banner-success" role="status">
          {notice}
        </div>
      ) : null}

      <div className="settings-profile-grid">
        <div className="settings-profile-intro">
          <h2>Profile</h2>
          <p>
            How you appear to agents in your salon, and the defaults used when
            you start a new Talk.
          </p>
        </div>

        <section className="settings-profile-form" aria-label="Profile">
          <div className="profile-avatar-section">
            <span
              className="profile-avatar-lg"
              style={{ background: gradient }}
            >
              {initials}
            </span>
            <div className="profile-avatar-copy">
              <button type="button" className="secondary-btn" disabled>
                Replace photo
              </button>
              <span>PNG or JPG, max 2 MB</span>
            </div>
          </div>

          <label className="profile-field">
            <span className="profile-field-label">Display name</span>
            <input
              type="text"
              className="profile-field-input"
              value={nameDraft}
              onChange={(event) => setNameDraft(event.target.value)}
            />
          </label>

          <label className="profile-field">
            <span className="profile-field-label">Salon handle</span>
            <input
              type="text"
              className="profile-field-input profile-field-locked"
              value={handle}
              readOnly
            />
            <span className="profile-field-hint">
              Derived from your display name.
            </span>
          </label>

          <label className="profile-field">
            <span className="profile-field-label">Email</span>
            <input
              type="text"
              className="profile-field-input profile-field-locked"
              value={user.email}
              readOnly
            />
          </label>

          <div className="profile-role-row">
            <span
              className={`profile-role-badge profile-role-badge-${user.role}`}
            >
              {formatRole(user.role)}
            </span>
            <span>
              Workspace: <strong>{currentWorkspace}</strong>
            </span>
          </div>

          <p className="profile-field-hint">{roleDescription(user.role)}</p>

          <div className="profile-meta-grid" aria-label="Account details">
            <div>
              <span className="settings-label">User ID</span>
              <strong className="profile-meta-value">
                {user.id.slice(0, 12)}…
              </strong>
            </div>
            <div>
              <span className="settings-label">Member since</span>
              <strong>{formatProfileDate(user.createdAt)}</strong>
            </div>
          </div>

          <div className="profile-actions">
            <button
              type="button"
              className="primary-btn"
              disabled={!hasNameChange || saving}
              onClick={() => void handleSave()}
            >
              {saving ? 'Saving…' : 'Save changes'}
            </button>
            <button
              type="button"
              className="secondary-btn"
              disabled={!hasNameChange || saving}
              onClick={() => setNameDraft(user.displayName)}
            >
              Discard
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
