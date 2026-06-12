import { useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import type { SessionUser, SessionWorkspace } from '../../lib/api';
import { Avatar, CTIcon, CTMark, salon } from '../../salon';
import type { CTIconName } from '../../salon';
import { RailProfileMenu } from './RailProfileMenu';
import { getUserAvatar } from './userAvatar';

type Props = {
  user: SessionUser;
  workspaces: SessionWorkspace[];
  currentWorkspaceId: string | undefined;
  onSwitchWorkspace: (workspaceId: string) => void | Promise<void>;
  onSignOut: () => void;
  signOutBusy: boolean;
  onOpenPalette: () => void;
  /** Toggle the secondary talk-list column (collapse on desktop / drawer on mobile). */
  onToggleSecondary: () => void;
  /** Whether the current route shows the secondary column at all. */
  secondaryAvailable: boolean;
};

type NavItem = {
  id: string;
  label: string;
  icon: CTIconName;
  to: string;
  isActive: (pathname: string, tab: string | null) => boolean;
};

const NAV_ITEMS: NavItem[] = [
  {
    id: 'home',
    label: 'Home',
    icon: 'home',
    to: '/app/home',
    isActive: (p) => p === '/app/home' || p === '/app' || p === '/',
  },
  {
    id: 'talks',
    label: 'Talks',
    icon: 'chat',
    to: '/app/talks',
    isActive: (p) => p.startsWith('/app/talks') || p.startsWith('/app/buddy'),
  },
  {
    id: 'documents',
    label: 'Documents',
    icon: 'doc',
    to: '/app/documents',
    isActive: (p) => p.startsWith('/app/documents'),
  },
  {
    id: 'agents',
    label: 'Agents',
    icon: 'sparkle',
    to: '/app/agents',
    isActive: (p, tab) =>
      p.startsWith('/app/agents') ||
      (p.startsWith('/app/settings') && tab === 'agents'),
  },
];

function RailButton({
  label,
  active,
  onClick,
  children,
  ariaCurrent,
  pressed,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  ariaCurrent?: boolean;
  pressed?: boolean;
}): JSX.Element {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-current={ariaCurrent && active ? 'page' : undefined}
      aria-pressed={pressed}
      onClick={onClick}
      className="ct-rail-btn"
      style={{
        background: active ? salon.card : 'transparent',
        color: active ? salon.ink : salon.ink2,
        boxShadow: active ? `inset 0 0 0 1px ${salon.line}` : 'none',
      }}
    >
      {children}
    </button>
  );
}

export function IconRail({
  user,
  workspaces,
  currentWorkspaceId,
  onSwitchWorkspace,
  onSignOut,
  signOutBusy,
  onOpenPalette,
  onToggleSecondary,
  secondaryAvailable,
}: Props): JSX.Element {
  const location = useLocation();
  const navigate = useNavigate();
  const [profileOpen, setProfileOpen] = useState(false);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const profileBtnRef = useRef<HTMLButtonElement | null>(null);
  const { initials, color } = getUserAvatar(user);
  const tab = new URLSearchParams(location.search).get('tab');
  const profileActive = location.pathname.startsWith('/app/settings');

  const openProfile = () => {
    setAnchorRect(profileBtnRef.current?.getBoundingClientRect() ?? null);
    setProfileOpen((value) => !value);
  };

  return (
    <nav className="ct-rail" aria-label="Primary">
      <div className="ct-rail-brand">
        <CTMark size={28} title="ClawTalk" />
      </div>

      {NAV_ITEMS.map((item) => (
        <RailButton
          key={item.id}
          label={item.label}
          active={item.isActive(location.pathname, tab)}
          ariaCurrent
          onClick={() => navigate(item.to)}
        >
          <CTIcon name={item.icon} size={18} strokeWidth={1.7} />
        </RailButton>
      ))}

      <div className="ct-rail-spacer" />

      {secondaryAvailable ? (
        <RailButton
          label="Toggle talk list"
          active={false}
          onClick={onToggleSecondary}
        >
          <CTIcon name="sidebar" size={18} strokeWidth={1.7} />
        </RailButton>
      ) : null}

      <RailButton
        label="Open command palette"
        active={false}
        onClick={onOpenPalette}
      >
        <CTIcon name="cmd" size={18} strokeWidth={1.7} />
      </RailButton>

      <div className="ct-rail-profile">
        <button
          ref={profileBtnRef}
          type="button"
          className="ct-rail-profile-btn"
          aria-haspopup="menu"
          aria-expanded={profileOpen}
          aria-label={`${user.displayName} — account and workspace menu`}
          title={user.displayName}
          onClick={openProfile}
          style={{
            boxShadow:
              profileActive || profileOpen
                ? `0 0 0 2px ${salon.paper2}, 0 0 0 3.5px ${salon.accent}`
                : `0 0 0 2px ${salon.paper2}, 0 0 0 3px ${salon.line}`,
          }}
        >
          <Avatar initials={initials} color={color} size={32} />
        </button>
        {profileOpen ? (
          <RailProfileMenu
            anchorRect={anchorRect}
            user={user}
            workspaces={workspaces}
            currentWorkspaceId={currentWorkspaceId}
            onSwitchWorkspace={onSwitchWorkspace}
            onSignOut={onSignOut}
            signOutBusy={signOutBusy}
            onClose={() => {
              setProfileOpen(false);
              // Restore focus to the trigger for keyboard users (Escape /
              // backdrop dismiss). The rail persists across navigation, so this
              // is a safe landing spot even when a menu link routed away.
              requestAnimationFrame(() => {
                if (profileBtnRef.current?.isConnected) {
                  profileBtnRef.current.focus();
                }
              });
            }}
          />
        ) : null}
      </div>
    </nav>
  );
}
