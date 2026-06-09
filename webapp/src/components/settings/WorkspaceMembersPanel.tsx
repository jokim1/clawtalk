import { Crown, Trash2, UserPlus } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import {
  ApiError,
  type SessionUser,
  type WorkspaceMember,
  type WorkspaceRole,
  getSessionMe,
  inviteWorkspaceMember,
  listWorkspaceMembers,
  removeWorkspaceMember,
  transferWorkspaceOwnership,
  UnauthorizedError,
  updateWorkspaceMemberRole,
} from '../../lib/api';

type WorkspaceMembersPanelProps = {
  user: SessionUser;
  onUnauthorized: () => void;
  onUserUpdated: (user: SessionUser) => void;
};

type EditableWorkspaceRole = Exclude<WorkspaceRole, 'owner'>;

const EDITABLE_ROLES: EditableWorkspaceRole[] = ['admin', 'member', 'guest'];

function formatRole(role: WorkspaceRole): string {
  switch (role) {
    case 'owner':
      return 'Owner';
    case 'admin':
      return 'Admin';
    case 'member':
      return 'Member';
    case 'guest':
      return 'Guest';
  }
}

function memberInitials(member: WorkspaceMember): string {
  return member.initials || member.name.slice(0, 2).toUpperCase() || '?';
}

function displayError(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

export function WorkspaceMembersPanel({
  user,
  onUnauthorized,
  onUserUpdated,
}: WorkspaceMembersPanelProps): JSX.Element {
  const workspaceId = user.currentWorkspaceId ?? '';
  const canManage = user.role === 'owner' || user.role === 'admin';
  const canTransfer = user.role === 'owner';
  const [members, setMembers] = useState<WorkspaceMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [emailDraft, setEmailDraft] = useState('');
  const [roleDraft, setRoleDraft] = useState<EditableWorkspaceRole>('member');
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const refreshMembers = useCallback(async (): Promise<void> => {
    if (!workspaceId) {
      setMembers([]);
      setLoading(false);
      return;
    }
    try {
      const next = await listWorkspaceMembers({ workspaceId });
      setMembers(next);
      setError(null);
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      setError(displayError(err, 'Failed to load workspace members.'));
    } finally {
      setLoading(false);
    }
  }, [onUnauthorized, workspaceId]);

  useEffect(() => {
    setLoading(true);
    void refreshMembers();
  }, [refreshMembers]);

  const refreshSession = async (): Promise<void> => {
    try {
      const updated = await getSessionMe();
      onUserUpdated(updated);
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized();
      }
    }
  };

  const runMutation = async (
    key: string,
    fn: () => Promise<void>,
    successMessage: string,
  ): Promise<void> => {
    setBusyKey(key);
    setError(null);
    setNotice(null);
    try {
      await fn();
      await refreshMembers();
      setNotice(successMessage);
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      setError(displayError(err, 'Workspace member update failed.'));
    } finally {
      setBusyKey(null);
    }
  };

  const handleInvite = async (): Promise<void> => {
    const email = emailDraft.trim();
    if (!email) {
      setError('Enter an email address.');
      return;
    }
    await runMutation(
      'invite',
      async () => {
        await inviteWorkspaceMember({
          workspaceId,
          email,
          role: roleDraft,
        });
        setEmailDraft('');
      },
      'Workspace member added.',
    );
  };

  const handleRoleChange = async (
    member: WorkspaceMember,
    role: EditableWorkspaceRole,
  ): Promise<void> => {
    await runMutation(
      `role:${member.userId}`,
      async () => {
        await updateWorkspaceMemberRole({
          workspaceId,
          userId: member.userId,
          role,
        });
        if (member.userId === user.id) {
          await refreshSession();
        }
      },
      'Role updated.',
    );
  };

  const handleRemove = async (member: WorkspaceMember): Promise<void> => {
    const confirmed =
      typeof window === 'undefined' ||
      window.confirm(`Remove ${member.name} from this workspace?`);
    if (!confirmed) return;
    await runMutation(
      `remove:${member.userId}`,
      async () => {
        await removeWorkspaceMember({ workspaceId, userId: member.userId });
      },
      'Workspace member removed.',
    );
  };

  const handleTransfer = async (member: WorkspaceMember): Promise<void> => {
    const confirmed =
      typeof window === 'undefined' ||
      window.confirm(`Transfer workspace ownership to ${member.name}?`);
    if (!confirmed) return;
    await runMutation(
      `transfer:${member.userId}`,
      async () => {
        await transferWorkspaceOwnership({
          workspaceId,
          newOwnerUserId: member.userId,
        });
        await refreshSession();
      },
      'Ownership transferred.',
    );
  };

  if (!workspaceId) {
    return (
      <section className="settings-banner settings-banner-warning">
        Workspace context is unavailable.
      </section>
    );
  }

  return (
    <>
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

      <section className="settings-card">
        <h2>Workspace Members</h2>
        {loading ? (
          <p className="page-state">Loading members...</p>
        ) : (
          <div className="workspace-members-list">
            {members.map((member) => {
              const isSelf = member.userId === user.id;
              const isOwner = member.role === 'owner';
              const roleBusy = busyKey === `role:${member.userId}`;
              const removeBusy = busyKey === `remove:${member.userId}`;
              const transferBusy = busyKey === `transfer:${member.userId}`;
              return (
                <div className="workspace-member-row" key={member.userId}>
                  <span className="workspace-member-avatar" aria-hidden="true">
                    {memberInitials(member)}
                  </span>
                  <div className="workspace-member-identity">
                    <strong>
                      {member.name}
                      {isSelf ? ' (you)' : ''}
                    </strong>
                    <span>{member.email}</span>
                  </div>
                  <div className="workspace-member-controls">
                    {canManage && !isOwner ? (
                      <label className="workspace-member-role-select">
                        <select
                          aria-label={`Role for ${member.name}`}
                          value={member.role}
                          disabled={roleBusy}
                          onChange={(event) =>
                            void handleRoleChange(
                              member,
                              event.target.value as EditableWorkspaceRole,
                            )
                          }
                        >
                          {EDITABLE_ROLES.map((role) => (
                            <option key={role} value={role}>
                              {formatRole(role)}
                            </option>
                          ))}
                        </select>
                      </label>
                    ) : (
                      <span
                        className={`profile-role-badge profile-role-badge-${member.role}`}
                      >
                        {formatRole(member.role)}
                      </span>
                    )}
                    {canTransfer && !isSelf ? (
                      <button
                        type="button"
                        className="secondary-btn workspace-member-icon-btn"
                        disabled={transferBusy || member.role === 'owner'}
                        onClick={() => void handleTransfer(member)}
                        title={`Transfer ownership to ${member.name}`}
                        aria-label={`Transfer ownership to ${member.name}`}
                      >
                        <Crown size={16} aria-hidden="true" />
                      </button>
                    ) : null}
                    {canManage && !isOwner && !isSelf ? (
                      <button
                        type="button"
                        className="secondary-btn workspace-member-icon-btn"
                        disabled={removeBusy}
                        onClick={() => void handleRemove(member)}
                        title={`Remove ${member.name}`}
                        aria-label={`Remove ${member.name}`}
                      >
                        <Trash2 size={16} aria-hidden="true" />
                      </button>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {canManage ? (
        <section className="settings-card">
          <h2>Add Member</h2>
          <div className="settings-form-grid workspace-members-invite">
            <label>
              <span className="settings-label">Email</span>
              <input
                type="email"
                value={emailDraft}
                onChange={(event) => setEmailDraft(event.target.value)}
                placeholder="name@example.com"
              />
            </label>
            <label>
              <span className="settings-label">Role</span>
              <select
                value={roleDraft}
                onChange={(event) =>
                  setRoleDraft(event.target.value as EditableWorkspaceRole)
                }
              >
                {EDITABLE_ROLES.map((role) => (
                  <option key={role} value={role}>
                    {formatRole(role)}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="primary-btn workspace-members-add-btn"
              disabled={busyKey === 'invite'}
              onClick={() => void handleInvite()}
            >
              <UserPlus size={16} aria-hidden="true" />
              Add
            </button>
          </div>
        </section>
      ) : null}
    </>
  );
}
