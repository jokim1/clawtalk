import type { SessionUser } from '../../lib/api';

/**
 * Initials + a deterministic avatar fill for a session user. Shared by the
 * icon rail's profile button and the rail profile popover so the same face
 * renders in both places. Ported from the former SidebarProfileMenu.
 */
const AVATAR_GRADIENTS = [
  'linear-gradient(135deg, #6366f1, #8b5cf6)',
  'linear-gradient(135deg, #3b82f6, #06b6d4)',
  'linear-gradient(135deg, #10b981, #34d399)',
  'linear-gradient(135deg, #f59e0b, #f97316)',
  'linear-gradient(135deg, #ef4444, #f43f5e)',
  'linear-gradient(135deg, #8b5cf6, #ec4899)',
  'linear-gradient(135deg, #14b8a6, #3b82f6)',
  'linear-gradient(135deg, #f97316, #ef4444)',
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
  return AVATAR_GRADIENTS[Math.abs(hash) % AVATAR_GRADIENTS.length];
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
