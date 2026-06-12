import { useEffect, useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';

import type { SessionUser, SessionWorkspace } from '../../lib/api';
import { Avatar, CTIcon } from '../../salon';
import type { CTIconName } from '../../salon';
import { getUserAvatar, getWorkspaceColor } from './userAvatar';

type Props = {
  /** Rect of the rail profile button; the popover anchors to its right edge. */
  anchorRect: DOMRect | null;
  user: SessionUser;
  workspaces: SessionWorkspace[];
  currentWorkspaceId: string | undefined;
  onSwitchWorkspace: (workspaceId: string) => void | Promise<void>;
  onCreateWorkspace: (name: string) => void | Promise<void>;
  onSignOut: () => void;
  signOutBusy: boolean;
  onClose: () => void;
};

type MenuLink = { label: string; to: string; icon: CTIconName };

const WORKSPACE_LINKS: MenuLink[] = [
  { label: 'Members', to: '/app/settings?tab=members', icon: 'settings' },
  { label: 'AI agents', to: '/app/settings?tab=agents', icon: 'sparkle' },
  { label: 'Tools', to: '/app/settings?tab=tools', icon: 'globe' },
  { label: 'Connectors', to: '/app/settings?tab=connectors', icon: 'folder' },
];

const ACCOUNT_LINKS: MenuLink[] = [
  { label: 'Profile', to: '/app/settings?tab=profile', icon: 'settings' },
  { label: 'API keys', to: '/app/settings?tab=api-keys', icon: 'bolt' },
];

const DESKTOP_WIDTH = 520;

function titleCaseRole(role: string | null | undefined): string | null {
  if (!role) return null;
  return role.charAt(0).toUpperCase() + role.slice(1);
}

function roleLabel(
  user: SessionUser,
  activeWorkspace: SessionWorkspace | null,
): string | null {
  return titleCaseRole(activeWorkspace?.role ?? user.role);
}

function defaultWorkspaceName(
  user: SessionUser,
  workspaces: SessionWorkspace[],
): string {
  const ownerName = user.displayName.trim() || user.email.split('@')[0] || 'My';
  const base = `${ownerName}'s workspace`;
  const existing = new Set(workspaces.map((workspace) => workspace.name));
  if (!existing.has(base)) return base;

  let index = workspaces.length + 1;
  while (existing.has(`${base} ${index}`)) {
    index += 1;
  }
  return `${base} ${index}`;
}

export function RailProfileMenu({
  anchorRect,
  user,
  workspaces,
  currentWorkspaceId,
  onSwitchWorkspace,
  onCreateWorkspace,
  onSignOut,
  signOutBusy,
  onClose,
}: Props): JSX.Element | null {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const createInputRef = useRef<HTMLInputElement | null>(null);
  const [switching, setSwitching] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createBusy, setCreateBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  const { initials, color } = getUserAvatar(user);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    panelRef.current?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    if (!creating) return;
    createInputRef.current?.focus();
    createInputRef.current?.select();
  }, [creating]);

  if (typeof document === 'undefined') return null;

  const activeWorkspace =
    workspaces.find((workspace) => workspace.id === currentWorkspaceId) ??
    workspaces[0] ??
    null;
  const role = roleLabel(user, activeWorkspace);
  const workspaceActionName = activeWorkspace
    ? `Invite people to ${activeWorkspace.name}`
    : 'Invite people';

  const viewportW =
    typeof window !== 'undefined' ? window.innerWidth : DESKTOP_WIDTH + 80;
  const viewportH = typeof window !== 'undefined' ? window.innerHeight : 800;
  const width = Math.min(DESKTOP_WIDTH, Math.max(280, viewportW - 16));
  const left = anchorRect
    ? Math.max(8, Math.min(anchorRect.right + 8, viewportW - width - 8))
    : 64;
  const bottom = anchorRect ? Math.max(8, viewportH - anchorRect.bottom) : 16;
  const maxHeight = anchorRect
    ? Math.max(240, viewportH - bottom - 12)
    : viewportH - 32;

  const goTo = (to: string) => () => {
    onClose();
    navigate(to);
  };

  const handleSwitch = async (workspaceId: string) => {
    if (workspaceId === currentWorkspaceId || switching || createBusy) {
      onClose();
      return;
    }
    setSwitching(true);
    setError(null);
    try {
      await onSwitchWorkspace(workspaceId);
      onClose();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Failed to switch workspace',
      );
    } finally {
      setSwitching(false);
    }
  };

  const startCreate = () => {
    setCreateName(defaultWorkspaceName(user, workspaces));
    setCreating(true);
    setError(null);
  };

  const handleCreate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (createBusy) return;
    const name = createName.trim();
    if (!name) {
      setError('Workspace name is required.');
      return;
    }
    if (name.length > 120) {
      setError('Workspace name must be 120 characters or fewer.');
      return;
    }

    setCreateBusy(true);
    setError(null);
    try {
      await onCreateWorkspace(name);
      onClose();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Failed to create workspace',
      );
    } finally {
      setCreateBusy(false);
    }
  };

  return createPortal(
    <>
      <div
        className="ct-rail-profile-backdrop"
        onMouseDown={onClose}
        aria-hidden="true"
      />
      <div
        ref={panelRef}
        role="menu"
        aria-label="Account and workspace menu"
        tabIndex={-1}
        className="ct-rail-profile-menu ct-screen-enter ct-thin-scroll"
        style={{
          left,
          bottom,
          width,
          maxWidth: 'calc(100vw - 16px)',
          maxHeight,
        }}
      >
        <section className="ct-rail-profile-workspaces">
          <div className="ct-rail-profile-section-head">
            <div className="ct-rail-profile-section-title">
              <h2>Workspaces</h2>
              <span aria-label={`${workspaces.length} workspaces`}>
                {workspaces.length}
              </span>
            </div>
            <button
              type="button"
              role="menuitem"
              aria-label="+ Workspace"
              disabled={switching || createBusy || creating}
              onClick={startCreate}
              className="ct-rail-profile-workspace-add"
            >
              <CTIcon name="plus" size={13} strokeWidth={2} />
              <span>Workspace</span>
            </button>
          </div>

          {creating ? (
            <form
              className="ct-rail-profile-create-form"
              onSubmit={(event) => void handleCreate(event)}
            >
              <label
                className="ct-rail-profile-create-label"
                htmlFor="ct-rail-profile-create-name"
              >
                Workspace name
              </label>
              <input
                ref={createInputRef}
                id="ct-rail-profile-create-name"
                type="text"
                value={createName}
                maxLength={120}
                disabled={createBusy}
                onChange={(event) => setCreateName(event.target.value)}
              />
              <div className="ct-rail-profile-create-actions">
                <button
                  type="button"
                  disabled={createBusy}
                  onClick={() => {
                    setCreating(false);
                    setCreateName('');
                    setError(null);
                  }}
                >
                  Cancel
                </button>
                <button type="submit" disabled={createBusy}>
                  {createBusy ? 'Creating…' : 'Create'}
                </button>
              </div>
            </form>
          ) : null}

          <div className="ct-rail-profile-workspace-list">
            {workspaces.map((workspace) => {
              const active = workspace.id === activeWorkspace?.id;
              return (
                <button
                  key={workspace.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={active}
                  disabled={switching || createBusy}
                  onClick={() => void handleSwitch(workspace.id)}
                  className={`ct-rail-profile-workspace${active ? ' active' : ''}`}
                >
                  <span
                    className="ct-rail-profile-workspace-avatar"
                    style={{ background: getWorkspaceColor(workspace.id) }}
                    aria-hidden="true"
                  >
                    {workspace.initials}
                  </span>
                  <span className="ct-rail-profile-workspace-name">
                    {workspace.name}
                  </span>
                  {active ? (
                    <CTIcon
                      name="check"
                      size={13}
                      className="ct-rail-profile-workspace-check"
                      strokeWidth={2.4}
                    />
                  ) : null}
                </button>
              );
            })}
          </div>

          {error ? (
            <p className="ct-rail-profile-error" role="alert">
              {error}
            </p>
          ) : null}

          <div className="ct-rail-profile-signout">
            <Avatar initials={initials} color={color} size={22} />
            <button
              type="button"
              role="menuitem"
              disabled={signOutBusy}
              onClick={() => {
                onClose();
                onSignOut();
              }}
            >
              <CTIcon name="logout" size={12} strokeWidth={1.8} />
              {signOutBusy ? 'Signing out…' : 'Log out'}
            </button>
          </div>
        </section>

        <section className="ct-rail-profile-account">
          <div className="ct-rail-profile-user">
            <Avatar initials={initials} color={color} size={40} />
            <div className="ct-rail-profile-user-copy">
              <strong>{user.displayName}</strong>
              <span>{user.email}</span>
            </div>
            {role ? <span className="ct-rail-profile-role">{role}</span> : null}
          </div>

          <div className="ct-rail-profile-status" aria-label="Status">
            <span aria-hidden="true" />
            Available · agents may notify
            <em>Edit</em>
          </div>

          <div className="ct-rail-profile-divider" />

          <div className="ct-rail-profile-row-group">
            {WORKSPACE_LINKS.map((link) => (
              <button
                key={link.to}
                type="button"
                role="menuitem"
                onClick={goTo(link.to)}
                className="ct-rail-profile-row"
              >
                <CTIcon name={link.icon} size={14} strokeWidth={1.6} />
                {link.label === 'Members' ? workspaceActionName : link.label}
              </button>
            ))}
          </div>

          <div className="ct-rail-profile-divider" />

          <div className="ct-rail-profile-row-group">
            {ACCOUNT_LINKS.map((link) => (
              <button
                key={link.to}
                type="button"
                role="menuitem"
                onClick={goTo(link.to)}
                className="ct-rail-profile-row"
              >
                <CTIcon name={link.icon} size={14} strokeWidth={1.6} />
                {link.label}
              </button>
            ))}
            <a
              href="https://clawtalk.app/help"
              target="_blank"
              rel="noreferrer"
              role="menuitem"
              onClick={onClose}
              className="ct-rail-profile-row"
            >
              <CTIcon name="globe" size={14} strokeWidth={1.6} />
              Help
            </a>
          </div>
        </section>
      </div>
    </>,
    document.body,
  );
}
