/**
 * Agent profile — read-only detail view for one RegisteredAgent.
 *
 * Salon-native, presentational only: the page wrapper owns data + load state.
 * Mutations live in Settings → Agents (RegisteredAgentsPanel); this view links
 * there rather than duplicating the editor. Model-lifecycle notices are shown
 * for context but are informational here (acting on them is a Settings action).
 */
import type { CSSProperties, ReactNode } from 'react';
import { Link } from 'react-router-dom';

import type { RegisteredAgent } from '../../lib/api';
import { Chip } from '../../salon/Chip';
import { salon, salonFont } from '../../salon/tokens';
import { credentialModeLabel, formatAgentDate } from './agentFormat';

const AGENTS_TAB_PATH = '/app/settings?tab=agents';

const CARD: CSSProperties = {
  background: salon.card,
  border: `1px solid ${salon.line}`,
  borderRadius: 16,
  padding: 20,
  display: 'flex',
  flexDirection: 'column',
  gap: 16,
};

function ActionLink({
  to,
  variant = 'secondary',
  children,
}: {
  to: string;
  variant?: 'primary' | 'secondary';
  children: ReactNode;
}): JSX.Element {
  const tone: CSSProperties =
    variant === 'primary'
      ? {
          background: salon.accent,
          color: '#fff',
          border: '1px solid transparent',
        }
      : {
          background: salon.card,
          color: salon.ink,
          border: `1px solid ${salon.line}`,
        };
  return (
    <Link
      to={to}
      className="salon-btn"
      style={{
        ...tone,
        height: 36,
        padding: '0 16px',
        borderRadius: 9999,
        fontFamily: salonFont.sans,
        fontSize: 13,
        fontWeight: 500,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        textDecoration: 'none',
      }}
    >
      {children}
    </Link>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <dt
        style={{
          fontFamily: salonFont.mono,
          fontSize: 10.5,
          textTransform: 'uppercase',
          letterSpacing: '0.14em',
          color: salon.ink2,
        }}
      >
        {label}
      </dt>
      <dd style={{ margin: 0, fontSize: 14, color: salon.ink }}>{children}</dd>
    </div>
  );
}

export function AgentProfile({
  agent,
  providerName,
  modelLabel,
}: {
  agent: RegisteredAgent;
  providerName: string;
  modelLabel: string;
}): JSX.Element {
  const ready = agent.executionPreview.ready;
  return (
    <article style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div>
        <Link
          to={AGENTS_TAB_PATH}
          className="salon-btn"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 12.5,
            color: salon.ink2,
            textDecoration: 'none',
          }}
        >
          ← Agents
        </Link>
      </div>

      <header style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <h1
          style={{
            margin: 0,
            fontFamily: salonFont.serif,
            fontSize: 28,
            fontWeight: 500,
            color: salon.ink,
            overflowWrap: 'anywhere',
          }}
        >
          {agent.name}
        </h1>
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            gap: 8,
          }}
        >
          <Chip tone="ghost">{providerName}</Chip>
          {agent.personaRole ? (
            <Chip tone="ghost">{agent.personaRole}</Chip>
          ) : null}
          <Chip tone={agent.enabled ? 'paper' : 'ghost'} active={agent.enabled}>
            {agent.enabled ? 'Active' : 'Disabled'}
          </Chip>
        </div>
        {agent.description ? (
          <p
            style={{
              margin: 0,
              fontSize: 14,
              lineHeight: 1.5,
              color: salon.ink2,
            }}
          >
            {agent.description}
          </p>
        ) : null}
      </header>

      <section
        style={{
          ...CARD,
          gap: 8,
          borderColor: ready ? salon.line : '#ecc4c7',
          background: ready ? salon.card : '#fbecec',
        }}
        aria-label="Execution readiness"
      >
        <div
          style={{
            fontFamily: salonFont.mono,
            fontSize: 10.5,
            textTransform: 'uppercase',
            letterSpacing: '0.14em',
            color: ready ? salon.ink2 : '#7b2a30',
          }}
        >
          {ready ? 'Ready to run' : 'Not ready'}
        </div>
        <div style={{ fontSize: 13.5, lineHeight: 1.5, color: salon.ink }}>
          {agent.executionPreview.message}
        </div>
      </section>

      <section style={CARD} aria-label="Configuration">
        <dl
          style={{
            margin: 0,
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
            gap: 16,
          }}
        >
          <Field label="Provider">{providerName}</Field>
          <Field label="Model">
            <span style={{ fontFamily: salonFont.mono, fontSize: 13 }}>
              {modelLabel}
            </span>
          </Field>
          <Field label="Credential mode">
            {credentialModeLabel(agent.credentialMode)}
          </Field>
          <Field label="Vision">
            {agent.supportsVision ? 'Supported' : 'Not supported'}
          </Field>
          <Field label="Created">{formatAgentDate(agent.createdAt)}</Field>
          <Field label="Updated">{formatAgentDate(agent.updatedAt)}</Field>
        </dl>
      </section>

      {agent.modelAutoUpgradedFrom || agent.modelUpdateAvailable ? (
        <section style={{ ...CARD, gap: 10 }} aria-label="Model lifecycle">
          {agent.modelAutoUpgradedFrom ? (
            <div style={{ fontSize: 13, color: salon.ink }}>
              Auto-upgraded from <code>{agent.modelAutoUpgradedFrom}</code>{' '}
              after the prior model retired.
            </div>
          ) : null}
          {agent.modelUpdateAvailable ? (
            <div style={{ fontSize: 13, color: salon.ink }}>
              A newer model is available:{' '}
              <code>
                {agent.modelUpdateAvailable.displayName ??
                  agent.modelUpdateAvailable.modelId}
              </code>
              . Apply it from Settings → Agents.
            </div>
          ) : null}
        </section>
      ) : null}

      {agent.systemPrompt ? (
        <section style={CARD} aria-label="System prompt">
          <div
            style={{
              fontFamily: salonFont.mono,
              fontSize: 10.5,
              textTransform: 'uppercase',
              letterSpacing: '0.14em',
              color: salon.ink2,
            }}
          >
            System prompt
          </div>
          <pre
            style={{
              margin: 0,
              whiteSpace: 'pre-wrap',
              overflowWrap: 'anywhere',
              fontFamily: salonFont.mono,
              fontSize: 12.5,
              lineHeight: 1.5,
              color: salon.ink,
            }}
          >
            {agent.systemPrompt}
          </pre>
        </section>
      ) : null}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <ActionLink to={AGENTS_TAB_PATH} variant="primary">
          Edit in Settings
        </ActionLink>
      </div>
    </article>
  );
}
