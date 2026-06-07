import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';

import type { SessionUser, SessionWorkspace } from '../../lib/api';
import { Avatar, CTIcon, salon, salonFont } from '../../salon';
import type { CTIconName } from '../../salon';
import { getUserAvatar, getWorkspaceColor } from './userAvatar';

type Props = {
  /** Rect of the rail profile button — the popover anchors to its right edge. */
  anchorRect: DOMRect | null;
  user: SessionUser;
  workspaces: SessionWorkspace[];
  currentWorkspaceId: string | undefined;
  onSwitchWorkspace: (workspaceId: string) => void | Promise<void>;
  onSignOut: () => void;
  signOutBusy: boolean;
  onClose: () => void;
};

type AccountLink = { label: string; to: string; icon: CTIconName };

const ACCOUNT_LINKS: AccountLink[] = [
  { label: 'Profile', to: '/app/settings?tab=profile', icon: 'settings' },
  { label: 'API keys', to: '/app/settings?tab=api-keys', icon: 'bolt' },
  { label: 'AI agents', to: '/app/settings?tab=agents', icon: 'sparkle' },
  { label: 'Tools', to: '/app/settings?tab=tools', icon: 'globe' },
  { label: 'Connectors', to: '/app/settings?tab=connectors', icon: 'folder' },
];

const WIDTH = 300;

export function RailProfileMenu({
  anchorRect,
  user,
  workspaces,
  currentWorkspaceId,
  onSwitchWorkspace,
  onSignOut,
  signOutBusy,
  onClose,
}: Props): JSX.Element | null {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [switching, setSwitching] = useState(false);
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
    // Move focus into the panel so Escape / tabbing is scoped here.
    panelRef.current?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (typeof document === 'undefined') return null;

  const goTo = (to: string) => () => {
    onClose();
    navigate(to);
  };

  const handleSwitch = async (workspaceId: string) => {
    if (workspaceId === currentWorkspaceId || switching) {
      onClose();
      return;
    }
    setSwitching(true);
    setError(null);
    try {
      await onSwitchWorkspace(workspaceId);
      // A successful switch reloads into the new workspace; closing is harmless.
      onClose();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Failed to switch workspace',
      );
    } finally {
      setSwitching(false);
    }
  };

  // Anchor to the right of the rail button, growing upward from its bottom edge.
  const viewportW =
    typeof window !== 'undefined' ? window.innerWidth : WIDTH + 80;
  const viewportH = typeof window !== 'undefined' ? window.innerHeight : 800;
  const left = anchorRect
    ? Math.min(anchorRect.right + 8, viewportW - WIDTH - 8)
    : 64;
  const bottom = anchorRect ? Math.max(8, viewportH - anchorRect.bottom) : 16;
  const maxHeight = anchorRect
    ? Math.max(220, anchorRect.bottom - 16)
    : viewportH - 32;

  const role = user.role
    ? user.role.charAt(0).toUpperCase() + user.role.slice(1)
    : null;

  return createPortal(
    <>
      <div
        style={{ position: 'fixed', inset: 0, zIndex: 1000 }}
        onMouseDown={onClose}
        aria-hidden="true"
      />
      <div
        ref={panelRef}
        role="menu"
        aria-label="Account and workspace menu"
        tabIndex={-1}
        className="ct-screen-enter ct-thin-scroll"
        style={{
          position: 'fixed',
          zIndex: 1001,
          left,
          bottom,
          width: WIDTH,
          maxWidth: 'calc(100vw - 16px)',
          maxHeight,
          overflowY: 'auto',
          background: salon.card,
          border: `1px solid ${salon.line}`,
          borderRadius: 16,
          boxShadow: '0 28px 64px rgba(31,27,22,0.22)',
          outline: 'none',
        }}
      >
        {/* User header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: 12,
            padding: '14px 16px 12px',
          }}
        >
          <Avatar initials={initials} color={color} size={40} />
          <div style={{ minWidth: 0, flex: 1 }}>
            <div
              style={{
                fontFamily: salonFont.serif,
                fontSize: 15,
                lineHeight: 1.2,
                color: salon.ink,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {user.displayName}
            </div>
            <div
              style={{
                fontSize: 12,
                color: salon.ink2,
                marginTop: 2,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {user.email}
            </div>
          </div>
          {role ? (
            <span
              style={{
                fontSize: 10,
                textTransform: 'uppercase',
                letterSpacing: '0.14em',
                fontFamily: salonFont.mono,
                background: '#3f6b5c',
                color: '#fff',
                padding: '2px 6px',
                borderRadius: 9999,
                flexShrink: 0,
              }}
            >
              {role}
            </span>
          ) : null}
        </div>

        {/* Workspaces */}
        {workspaces.length > 0 ? (
          <>
            <div style={{ height: 1, margin: '0 12px', background: salon.line }} />
            <div style={{ padding: '8px 8px 4px' }}>
              <div
                style={{
                  padding: '4px 8px',
                  fontSize: 10.5,
                  textTransform: 'uppercase',
                  letterSpacing: '0.14em',
                  fontWeight: 600,
                  color: salon.ink2,
                }}
              >
                Workspaces
              </div>
              {workspaces.map((workspace) => {
                const active = workspace.id === currentWorkspaceId;
                return (
                  <button
                    key={workspace.id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={active}
                    disabled={switching}
                    onClick={() => void handleSwitch(workspace.id)}
                    className="ct-rail-menu-row"
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      width: '100%',
                      padding: '6px 8px',
                      borderRadius: 8,
                      textAlign: 'left',
                      background: active ? salon.paper2 : 'transparent',
                      color: salon.ink,
                      border: 'none',
                      cursor: switching ? 'default' : 'pointer',
                    }}
                  >
                    <span
                      aria-hidden="true"
                      style={{
                        width: 22,
                        height: 22,
                        flexShrink: 0,
                        borderRadius: 6,
                        display: 'grid',
                        placeItems: 'center',
                        fontSize: 9.5,
                        fontFamily: salonFont.mono,
                        background: getWorkspaceColor(workspace.id),
                        color: '#fff',
                      }}
                    >
                      {workspace.initials}
                    </span>
                    <span
                      style={{
                        flex: 1,
                        minWidth: 0,
                        fontSize: 12.5,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        fontWeight: active ? 500 : 400,
                      }}
                    >
                      {workspace.name}
                    </span>
                    {active ? (
                      <CTIcon
                        name="check"
                        size={13}
                        stroke={salon.accent}
                        strokeWidth={2.4}
                      />
                    ) : null}
                  </button>
                );
              })}
              {error ? (
                <p
                  role="alert"
                  style={{
                    margin: '4px 8px 0',
                    fontSize: 11.5,
                    color: '#a8434a',
                  }}
                >
                  {error}
                </p>
              ) : null}
            </div>
          </>
        ) : null}

        {/* Account links */}
        <div style={{ height: 1, margin: '4px 12px', background: salon.line }} />
        <div style={{ padding: '4px 0' }}>
          {ACCOUNT_LINKS.map((link) => (
            <button
              key={link.to}
              type="button"
              role="menuitem"
              onClick={goTo(link.to)}
              className="ct-rail-menu-row"
              style={menuRowStyle}
            >
              <CTIcon name={link.icon} size={14} stroke={salon.ink2} strokeWidth={1.6} />
              {link.label}
            </button>
          ))}
          <a
            href="https://clawtalk.app/help"
            target="_blank"
            rel="noreferrer"
            role="menuitem"
            onClick={onClose}
            className="ct-rail-menu-row"
            style={{ ...menuRowStyle, textDecoration: 'none' }}
          >
            <CTIcon name="globe" size={14} stroke={salon.ink2} strokeWidth={1.6} />
            Help
          </a>
        </div>

        <div style={{ height: 1, margin: '4px 12px', background: salon.line }} />
        <div style={{ padding: '4px 0 8px' }}>
          <button
            type="button"
            role="menuitem"
            disabled={signOutBusy}
            onClick={() => {
              onClose();
              onSignOut();
            }}
            className="ct-rail-menu-row"
            style={{
              ...menuRowStyle,
              color: '#a8434a',
              cursor: signOutBusy ? 'default' : 'pointer',
            }}
          >
            <CTIcon name="logout" size={14} stroke="#a8434a" strokeWidth={1.7} />
            {signOutBusy ? 'Signing out…' : 'Log out'}
          </button>
        </div>
      </div>
    </>,
    document.body,
  );
}

const menuRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  width: '100%',
  padding: '7px 14px',
  fontSize: 13,
  textAlign: 'left',
  background: 'transparent',
  border: 'none',
  color: salon.ink,
  cursor: 'pointer',
};
