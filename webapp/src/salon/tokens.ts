/**
 * ClawTalk · Salon design tokens (TS surface).
 *
 * Mirrors the CSS custom properties in `salon.css` for use in inline styles
 * within Salon primitives — the same `var(--salon-*, <fallback>)` pattern the
 * reference prototype uses, so a runtime missing the stylesheet still renders
 * the correct palette. Ported from `shared/data.jsx` (CT_RUN_STATES, agent
 * accents) and docs/02-visual-system.md.
 */

export const salon = {
  ink: 'var(--salon-ink, #1f1b16)',
  ink2: 'var(--salon-ink-2, #6b6660)',
  paper: 'var(--salon-paper, #fbf7ef)',
  paper2: 'var(--salon-paper-2, #f4ecdb)',
  card: 'var(--salon-card, #ffffff)',
  line: 'var(--salon-line, #e6e0d1)',
  accent: 'var(--salon-accent, #c8643a)',
} as const;

export const salonFont = {
  serif: "var(--salon-font-serif, 'Newsreader', Georgia, serif)",
  display: "var(--salon-font-display, 'Instrument Serif', Georgia, serif)",
  sans: "var(--salon-font-sans, 'Geist', 'IBM Plex Sans', system-ui, sans-serif)",
  mono: "var(--salon-font-mono, 'Geist Mono', 'JetBrains Mono', ui-monospace, monospace)",
} as const;

export type RunStatus =
  | 'queued'
  | 'running'
  | 'awaiting'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface RunStateMeta {
  label: string;
  bg: string;
  fg: string;
  dot: string;
  border: string;
}

/** Run-state palette + labels, mirrored from `CT_RUN_STATES` in shared/data.jsx. */
export const RUN_STATES: Record<RunStatus, RunStateMeta> = {
  queued: {
    label: 'Queued',
    bg: '#f5f4f0',
    fg: '#6b6660',
    dot: '#a8a29e',
    border: '#e6e2da',
  },
  running: {
    label: 'Streaming',
    bg: '#eaf3ee',
    fg: '#235041',
    dot: '#3f6b5c',
    border: '#c9dfd3',
  },
  awaiting: {
    label: 'Awaiting',
    bg: '#faf1de',
    fg: '#7e5418',
    dot: '#c8893a',
    border: '#ead7a4',
  },
  completed: {
    label: 'Done',
    bg: '#eaeff9',
    fg: '#27407a',
    dot: '#3d5688',
    border: '#c9d5ee',
  },
  failed: {
    label: 'Failed',
    bg: '#fbecec',
    fg: '#7b2a30',
    dot: '#a8434a',
    border: '#ecc4c7',
  },
  cancelled: {
    label: 'Cancelled',
    bg: '#f4efe6',
    fg: '#5e5645',
    dot: '#8b7e6a',
    border: '#dcd2be',
  },
};

export type AgentRole =
  | 'strategist'
  | 'critic'
  | 'researcher'
  | 'editor'
  | 'quant';

export interface AgentAccent {
  accent: string;
  accentDark: string;
}

/** Agent accent hues, mirrored from `CT_AGENTS` / docs §1. */
export const AGENT_ACCENTS: Record<AgentRole, AgentAccent> = {
  strategist: { accent: '#c8643a', accentDark: '#e8855b' },
  critic: { accent: '#8e3b59', accentDark: '#d26086' },
  researcher: { accent: '#3f6b5c', accentDark: '#6ba98f' },
  editor: { accent: '#3d5688', accentDark: '#7b96d1' },
  quant: { accent: '#2a6f7e', accentDark: '#5ba8b8' },
};
