/**
 * Agent profile route (/app/agents/:agentId).
 *
 * Read-only detail for a single RegisteredAgent built on the existing
 * getRegisteredAgent contract. The agent fetch is the spine; the AiAgents
 * catalog is optional enrichment (friendly provider/model labels) that degrades
 * to humanized ids when it fails. States: loading, not-found (404), error
 * (with retry), ready.
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Link, useParams } from 'react-router-dom';

import {
  ApiError,
  getAiAgents,
  getRegisteredAgent,
  UnauthorizedError,
  type AiAgentsPageData,
  type RegisteredAgent,
} from '../lib/api';
import { Button, salon, salonFont } from '../salon';
import { AgentProfile } from '../components/agents/AgentProfile';
import {
  resolveModelLabel,
  resolveProviderName,
} from '../components/agents/agentFormat';

type LoadState =
  | { status: 'loading' }
  | { status: 'not-found' }
  | { status: 'error'; message: string }
  | { status: 'ready'; agent: RegisteredAgent; ai: AiAgentsPageData | null };

export function AgentProfilePage({
  workspaceId,
  onUnauthorized,
}: {
  workspaceId?: string | null;
  onUnauthorized: () => void;
}): JSX.Element {
  const { agentId } = useParams<{ agentId: string }>();
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  // Tracks the in-flight load so a retry / param change / unmount cancels the
  // prior request and no setState fires after unmount.
  const activeLoad = useRef<{ cancelled: boolean } | null>(null);

  const load = useCallback(async () => {
    if (activeLoad.current) activeLoad.current.cancelled = true;
    const signal = { cancelled: false };
    activeLoad.current = signal;

    if (!agentId) {
      setState({ status: 'not-found' });
      return;
    }

    setState({ status: 'loading' });
    const [agentRes, aiRes] = await Promise.allSettled([
      getRegisteredAgent(agentId, { workspaceId }),
      getAiAgents({ workspaceId }),
    ]);
    if (signal.cancelled) return;

    if (agentRes.status === 'rejected') {
      const reason = agentRes.reason;
      if (reason instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      if (reason instanceof ApiError && reason.status === 404) {
        setState({ status: 'not-found' });
        return;
      }
      setState({
        status: 'error',
        message:
          reason instanceof Error
            ? reason.message
            : 'This agent could not be loaded.',
      });
      return;
    }

    setState({
      status: 'ready',
      agent: agentRes.value,
      ai: aiRes.status === 'fulfilled' ? aiRes.value : null,
    });
  }, [agentId, workspaceId, onUnauthorized]);

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
        maxWidth: 820,
        margin: '0 auto',
        padding: '20px 20px 48px',
        display: 'flex',
        flexDirection: 'column',
        gap: 20,
      }}
    >
      {state.status === 'loading' ? <AgentProfileLoading /> : null}
      {state.status === 'not-found' ? <AgentNotFound /> : null}
      {state.status === 'error' ? (
        <AgentProfileError
          message={state.message}
          onRetry={() => void load()}
        />
      ) : null}
      {state.status === 'ready' ? (
        <AgentProfile
          agent={state.agent}
          providerName={resolveProviderName(state.ai, state.agent.providerId)}
          modelLabel={resolveModelLabel(state.ai, state.agent.modelId)}
        />
      ) : null}
    </div>
  );
}

function MessageCard({
  title,
  body,
  children,
}: {
  title: string;
  body: string;
  children?: ReactNode;
}): JSX.Element {
  return (
    <div
      style={{
        background: salon.card,
        border: `1px solid ${salon.line}`,
        borderRadius: 16,
        padding: 20,
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
      }}
    >
      <div
        style={{ fontFamily: salonFont.serif, fontSize: 19, color: salon.ink }}
      >
        {title}
      </div>
      <div style={{ fontSize: 13.5, lineHeight: 1.5, color: salon.ink2 }}>
        {body}
      </div>
      {children}
    </div>
  );
}

function AgentsBackLink(): JSX.Element {
  return (
    <Link
      to="/app/settings?tab=agents"
      className="salon-btn"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        height: 36,
        padding: '0 16px',
        borderRadius: 9999,
        fontFamily: salonFont.sans,
        fontSize: 13,
        fontWeight: 500,
        background: salon.card,
        color: salon.ink,
        border: `1px solid ${salon.line}`,
        textDecoration: 'none',
      }}
    >
      Back to Agents
    </Link>
  );
}

function AgentNotFound(): JSX.Element {
  return (
    <MessageCard
      title="Agent not found"
      body="This agent doesn’t exist, or it isn’t available in your current workspace."
    >
      <div>
        <AgentsBackLink />
      </div>
    </MessageCard>
  );
}

function AgentProfileError({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}): JSX.Element {
  return (
    <MessageCard title="Couldn’t load this agent" body={message}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <Button variant="secondary" onClick={onRetry}>
          Try again
        </Button>
        <AgentsBackLink />
      </div>
    </MessageCard>
  );
}

function AgentProfileLoading(): JSX.Element {
  return (
    <div
      aria-busy="true"
      aria-label="Loading agent"
      style={{ display: 'flex', flexDirection: 'column', gap: 16 }}
    >
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          style={{
            background: salon.card,
            border: `1px solid ${salon.line}`,
            borderRadius: 16,
            padding: 20,
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
          }}
        >
          <span
            className="ct-pulse"
            aria-hidden="true"
            style={{
              display: 'block',
              width: i === 0 ? '45%' : '30%',
              height: 14,
              borderRadius: 6,
              background: salon.paper2,
            }}
          />
          <span
            className="ct-pulse"
            aria-hidden="true"
            style={{
              display: 'block',
              width: '80%',
              height: 12,
              borderRadius: 6,
              background: salon.paper2,
            }}
          />
        </div>
      ))}
    </div>
  );
}
