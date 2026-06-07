/**
 * Avatar + AgentAvatar. Ported from shell.jsx (docs §4): round colored circle
 * with serif initials, optional emphasis ring. AgentAvatar maps an agent role
 * to its accent hue. `className`/`style` pass through so existing layout classes
 * survive a migration.
 */
import { salon, salonFont, AGENT_ACCENTS } from './tokens';
import type { AgentRole } from './tokens';
import type { CSSProperties } from 'react';

export interface AvatarProps {
  initials: string;
  color?: string;
  size?: number;
  ring?: boolean;
  title?: string;
  className?: string;
  style?: CSSProperties;
}

export function Avatar({
  initials,
  color = '#3f6b5c',
  size = 36,
  ring = false,
  title,
  className,
  style,
}: AvatarProps) {
  return (
    <span
      title={title}
      aria-hidden={title ? undefined : true}
      className={className}
      style={{
        width: size,
        height: size,
        flexShrink: 0,
        display: 'grid',
        placeItems: 'center',
        borderRadius: '9999px',
        background: color,
        color: '#fff',
        fontFamily: salonFont.serif,
        fontWeight: 500,
        fontSize: size * 0.36,
        lineHeight: 1,
        boxShadow: ring
          ? `0 0 0 2px ${salon.paper}, 0 0 0 3px ${color}55`
          : 'none',
        ...style,
      }}
    >
      {initials}
    </span>
  );
}

export interface AgentAvatarProps {
  initials: string;
  /** One of the canonical agent roles; sets the accent hue. */
  role?: AgentRole;
  /** Explicit accent override (wins over `role`). */
  accent?: string;
  size?: number;
  ring?: boolean;
  title?: string;
  className?: string;
  style?: CSSProperties;
}

export function AgentAvatar({
  initials,
  role,
  accent,
  size = 36,
  ring = false,
  title,
  className,
  style,
}: AgentAvatarProps) {
  const color = accent ?? (role ? AGENT_ACCENTS[role].accent : '#3f6b5c');
  return (
    <Avatar
      initials={initials}
      color={color}
      size={size}
      ring={ring}
      title={title}
      className={className}
      style={style}
    />
  );
}
