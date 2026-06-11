/**
 * Agents roster — Salon card grid over RegisteredAgent, ported from AgentCard
 * in docs/prototypes/prototype/agents.jsx. Presentational: the page owns
 * data/load state. Cards link to the standalone profile; create/edit/delete
 * stay in Settings → Agents, which the trailing add-slot links to. The
 * prototype's participation stats (rounds / talks) have no backing data yet,
 * so cards show provider + readiness chips instead of fabricated counts.
 */
import { Link } from 'react-router-dom';

import type { AiAgentsPageData, RegisteredAgent } from '../../lib/api';
import { AgentAvatar, Chip, CTIcon, salon, salonFont } from '../../salon';
import {
  agentAccent,
  agentInitials,
  resolveModelLabel,
  resolveProviderName,
} from './agentFormat';

const AGENTS_TAB_PATH = '/app/settings?tab=agents';

function RoleBadge({
  label,
  accent,
}: {
  label: string;
  accent: string;
}): JSX.Element {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '2px 8px',
        borderRadius: 9999,
        fontFamily: salonFont.sans,
        fontSize: 10.5,
        fontWeight: 500,
        background: `${accent}1a`,
        color: accent,
        border: `1px solid ${accent}33`,
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 6,
          height: 6,
          borderRadius: 9999,
          background: accent,
        }}
      />
      {label}
    </span>
  );
}

function AgentCard({
  agent,
  ai,
}: {
  agent: RegisteredAgent;
  ai: AiAgentsPageData | null;
}): JSX.Element {
  const accent = agentAccent(agent.personaRole?.trim() || agent.name);
  const ready = agent.executionPreview.ready;
  return (
    <Link
      to={`/app/agents/${encodeURIComponent(agent.id)}`}
      className="salon-btn"
      aria-label={`${agent.name} — view profile`}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        padding: 20,
        borderRadius: 16,
        background: salon.card,
        border: `1px solid ${salon.line}`,
        textDecoration: 'none',
        color: salon.ink,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <AgentAvatar
          initials={agentInitials(agent.name)}
          accent={accent}
          size={48}
          ring
        />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span
              style={{
                fontFamily: salonFont.serif,
                fontSize: 20,
                lineHeight: 1.15,
                color: salon.ink,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {agent.name}
            </span>
            {agent.enabled ? null : <Chip tone="ghost">disabled</Chip>}
          </div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              marginTop: 6,
              flexWrap: 'wrap',
            }}
          >
            <RoleBadge
              label={agent.personaRole?.trim() || 'Agent'}
              accent={accent}
            />
            <span
              style={{
                fontFamily: salonFont.mono,
                fontSize: 11,
                color: salon.ink2,
              }}
            >
              {resolveModelLabel(ai, agent.modelId)}
            </span>
          </div>
        </div>
      </div>

      {agent.description ? (
        <p
          style={{
            margin: 0,
            fontFamily: salonFont.serif,
            fontStyle: 'italic',
            fontSize: 14,
            lineHeight: 1.4,
            color: salon.ink2,
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
            overflowWrap: 'anywhere',
          }}
        >
          {agent.description}
        </p>
      ) : null}

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          marginTop: 'auto',
          paddingTop: 4,
          flexWrap: 'wrap',
        }}
      >
        <Chip tone="ghost">{resolveProviderName(ai, agent.providerId)}</Chip>
        <Chip tone={ready ? 'paper' : 'ghost'} active={ready}>
          {ready ? 'Ready' : 'Not ready'}
        </Chip>
        <span
          style={{
            marginLeft: 'auto',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            fontSize: 11.5,
            color: salon.ink2,
          }}
        >
          View profile
          <CTIcon name="arrow" size={11} stroke={salon.ink2} strokeWidth={1.8} />
        </span>
      </div>
    </Link>
  );
}

export function AgentRoster({
  agents,
  ai,
}: {
  agents: RegisteredAgent[];
  ai: AiAgentsPageData | null;
}): JSX.Element {
  return (
    <div
      style={{
        display: 'grid',
        // min(100%, …) lets the track shrink inside the narrow mobile column
        // (390px viewport minus rail + page padding leaves < 300px).
        gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 300px), 1fr))',
        gap: 16,
      }}
    >
      {agents.map((agent) => (
        <AgentCard key={agent.id} agent={agent} ai={ai} />
      ))}
      <Link
        to={AGENTS_TAB_PATH}
        className="salon-btn"
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          textAlign: 'center',
          gap: 6,
          minHeight: 180,
          borderRadius: 16,
          border: `2px dashed ${salon.line}`,
          background: 'transparent',
          color: salon.ink2,
          textDecoration: 'none',
        }}
      >
        <span
          aria-hidden="true"
          style={{
            width: 40,
            height: 40,
            borderRadius: 9999,
            display: 'grid',
            placeItems: 'center',
            background: 'var(--salon-paper-2, #f4ecdb)',
            border: `1px solid ${salon.line}`,
          }}
        >
          <CTIcon name="plus" size={16} stroke={salon.ink} strokeWidth={1.8} />
        </span>
        <span
          style={{
            fontSize: 14,
            fontWeight: 500,
            color: salon.ink,
            marginTop: 4,
          }}
        >
          Add a new agent
        </span>
        <span style={{ fontSize: 11.5 }}>
          Create and manage agents in Settings
        </span>
      </Link>
    </div>
  );
}
