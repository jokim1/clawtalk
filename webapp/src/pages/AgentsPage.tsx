/**
 * Agents route (/app/agents) — the standalone Salon roster screen, ported from
 * AgentsScreen in docs/prototypes/prototype/agents.jsx. Replaces the old
 * redirect to Settings → Agents: this page is the browse/IA surface; mutations
 * stay in Settings.
 *
 * The roster fetch is the spine; the AiAgents catalog is optional label
 * enrichment that never gates rendering (same contract as AgentProfilePage).
 * The prototype's "Team compositions" and "Discover" sections stay out until a
 * backend exists for them.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

import {
  getAiAgents,
  listRegisteredAgents,
  UnauthorizedError,
  type AiAgentsPageData,
  type RegisteredAgent,
} from '../lib/api';
import { Button, CTIcon, salon, salonFont } from '../salon';
import { AgentRoster } from '../components/agents/AgentRoster';

const AGENTS_TAB_PATH = '/app/settings?tab=agents';

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; agents: RegisteredAgent[]; ai: AiAgentsPageData | null };

export function AgentsPage({
  workspaceId,
  onUnauthorized,
}: {
  workspaceId?: string | null;
  onUnauthorized: () => void;
}): JSX.Element {
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  // Tracks the in-flight load so a retry / unmount cancels the prior request
  // and no setState fires after unmount.
  const activeLoad = useRef<{ cancelled: boolean } | null>(null);

  const load = useCallback(async () => {
    if (activeLoad.current) activeLoad.current.cancelled = true;
    const signal = { cancelled: false };
    activeLoad.current = signal;

    setState({ status: 'loading' });

    // The roster fetch is the only gating request; the catalog is slow-path
    // label enrichment (a cache miss triggers live model discovery) and must
    // never block the page or its error states.
    let agents: RegisteredAgent[];
    try {
      agents = await listRegisteredAgents({ workspaceId });
    } catch (reason) {
      if (signal.cancelled) return;
      if (reason instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      setState({
        status: 'error',
        message:
          reason instanceof Error
            ? reason.message
            : 'Agents could not be loaded.',
      });
      return;
    }
    if (signal.cancelled) return;
    setState({ status: 'ready', agents, ai: null });

    try {
      const ai = await getAiAgents({ workspaceId });
      if (signal.cancelled) return;
      setState((prev) =>
        prev.status === 'ready' ? { ...prev, ai } : prev,
      );
    } catch {
      // Labels stay humanized; the roster is already rendered.
    }
  }, [onUnauthorized, workspaceId]);

  useEffect(() => {
    void load();
    return () => {
      if (activeLoad.current) activeLoad.current.cancelled = true;
    };
  }, [load]);

  return (
    <div
      className="ct-screen-enter ct-thin-scroll"
      style={{
        width: '100%',
        maxWidth: 1240,
        margin: '0 auto',
        padding: '28px 36px 48px',
        display: 'flex',
        flexDirection: 'column',
        gap: 28,
      }}
    >
      <header style={{ display: 'flex', alignItems: 'flex-end', gap: 16 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontFamily: salonFont.mono,
              fontSize: 11,
              textTransform: 'uppercase',
              letterSpacing: '0.18em',
              color: salon.ink2,
            }}
          >
            Your team
          </div>
          <h1
            style={{
              margin: '4px 0 0',
              fontFamily: salonFont.serif,
              fontSize: 36,
              lineHeight: 1.05,
              fontWeight: 500,
              letterSpacing: '-0.01em',
              color: salon.ink,
            }}
          >
            Your agents. One{' '}
            <em style={{ color: salon.accent }}>argumentative</em> table.
          </h1>
          <p
            style={{
              margin: '8px 0 0',
              fontSize: 14,
              maxWidth: 660,
              color: salon.ink2,
            }}
          >
            Each agent has a role and a specific job. Edit their persona, swap
            their model, or tune their methodology from Settings.
          </p>
        </div>
        <Link
          to={AGENTS_TAB_PATH}
          className="salon-btn"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            height: 36,
            padding: '0 16px',
            borderRadius: 9999,
            flexShrink: 0,
            background: 'var(--salon-accent-strong, #b05530)',
            color: '#fff',
            fontFamily: salonFont.sans,
            fontSize: 13,
            fontWeight: 500,
            textDecoration: 'none',
          }}
        >
          <CTIcon name="plus" size={13} stroke="#fff" strokeWidth={2} />
          New agent
        </Link>
      </header>

      {state.status === 'loading' ? (
        <div
          aria-busy="true"
          aria-label="Loading agents"
          style={{
            display: 'grid',
            gridTemplateColumns:
              'repeat(auto-fill, minmax(min(100%, 300px), 1fr))',
            gap: 16,
          }}
        >
          {Array.from({ length: 3 }).map((_, i) => (
            <div
              key={i}
              className="ct-pulse"
              style={{
                height: 180,
                borderRadius: 16,
                background: 'var(--salon-paper-2, #f4ecdb)',
              }}
            />
          ))}
        </div>
      ) : state.status === 'error' ? (
        <div
          role="alert"
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'flex-start',
            gap: 12,
            padding: 20,
            borderRadius: 16,
            background: salon.card,
            border: `1px solid ${salon.line}`,
          }}
        >
          <div style={{ fontSize: 14, color: salon.ink }}>{state.message}</div>
          <Button onClick={() => void load()}>Retry</Button>
        </div>
      ) : state.agents.length === 0 ? (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 8,
            padding: '40px 20px',
            textAlign: 'center',
            borderRadius: 16,
            background: salon.card,
            border: `1px solid ${salon.line}`,
          }}
        >
          <div
            style={{
              fontFamily: salonFont.serif,
              fontSize: 18,
              color: salon.ink,
            }}
          >
            No agents yet
          </div>
          <div style={{ fontSize: 13, color: salon.ink2, maxWidth: 380 }}>
            Register an agent to invite it into your Talks.
          </div>
          <Link
            to={AGENTS_TAB_PATH}
            className="salon-btn"
            style={{
              marginTop: 8,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              height: 34,
              padding: '0 14px',
              borderRadius: 9999,
              background: 'var(--salon-accent-strong, #b05530)',
              color: '#fff',
              fontSize: 13,
              fontWeight: 500,
              textDecoration: 'none',
            }}
          >
            Create your first agent
          </Link>
        </div>
      ) : (
        <AgentRoster agents={state.agents} ai={state.ai} />
      )}
    </div>
  );
}
