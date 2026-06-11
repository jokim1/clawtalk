import type { SessionUser } from '../../lib/api';

/**
 * Initials + a deterministic avatar fill for a session user. Shared by the
 * icon rail's profile button, the rail profile popover, the Talk timeline,
 * and Settings' profile card so the same face renders everywhere.
 */
// Solid Salon-family hues (02-visual-system palette + earth-tone extensions).
const AVATAR_COLORS = [
  '#3f6b5c',
  '#8e3b59',
  '#3d5688',
  '#c8643a',
  '#2a6f7e',
  '#5e5645',
  '#6d5b3f',
  '#9a4d38',
];

export function getUserInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }
  return name.trim().slice(0, 2).toUpperCase() || '?';
}

export function getUserAvatarColor(userId: string): string {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = (hash * 31 + userId.charCodeAt(i)) | 0;
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

// Solid Salon-family hues for the small workspace squares in the profile menu
// (SessionWorkspace carries no color of its own).
const WORKSPACE_COLORS = [
  '#3f6b5c',
  '#c8643a',
  '#3d5688',
  '#8e3b59',
  '#2a6f7e',
  '#7e5418',
];

export function getWorkspaceColor(workspaceId: string): string {
  let hash = 0;
  for (let i = 0; i < workspaceId.length; i++) {
    hash = (hash * 31 + workspaceId.charCodeAt(i)) | 0;
  }
  return WORKSPACE_COLORS[Math.abs(hash) % WORKSPACE_COLORS.length];
}

export function getUserAvatar(user: Pick<SessionUser, 'id' | 'displayName'>): {
  initials: string;
  color: string;
} {
  return {
    initials: getUserInitials(user.displayName),
    color: getUserAvatarColor(user.id),
  };
}
