/**
 * Run-status pill. Ported from `RunPill` in shell.jsx (docs §4): filled
 * background + status dot + label. The dot pulses while `running`.
 */
import { RUN_STATES, salonFont } from './tokens';
import type { RunStatus } from './tokens';

export interface RunPillProps {
  status: RunStatus;
  /** Override the default status label. */
  label?: string;
  title?: string;
}

export function RunPill({ status, label, title }: RunPillProps) {
  const meta = RUN_STATES[status] ?? RUN_STATES.queued;
  return (
    <span
      title={title}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '2px 8px',
        borderRadius: '9999px',
        // Geist Mono for status pills (docs/02 §2: pills/metadata are mono).
        fontFamily: salonFont.mono,
        fontSize: 11,
        fontWeight: 500,
        background: meta.bg,
        color: meta.fg,
        border: `1px solid ${meta.border}`,
      }}
    >
      <span
        className={status === 'running' ? 'ct-pulse' : undefined}
        style={{
          width: 6,
          height: 6,
          borderRadius: '9999px',
          background: meta.dot,
          flexShrink: 0,
        }}
      />
      {label ?? meta.label}
    </span>
  );
}
