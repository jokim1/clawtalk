/**
 * Inbox preview — top actionable arrivals/blockers/waits (docs/07 §6.8). Shows
 * the highest-scored items (already ranked by the API). Ported from the inbox
 * rows in prototype/home-shared.jsx. Navigation actions route where possible;
 * each row also carries Mark-read, Resolve, Snooze, and Dismiss lifecycle
 * controls wired to the Home write API (the parent owns optimistic state).
 */
import { CTIcon, salon, salonFont } from '../../salon';
import type { HomeInboxItem, HomeInboxPayload } from '../../lib/api';
import {
  ActionButton,
  Card,
  clampLines,
  HomeEmpty,
  LifecycleIconButton,
  SectionHeader,
  SnoozeControl,
  TalkChip,
} from './HomeKit';
import {
  classifyAction,
  INBOX_SEVERITY_BADGE,
  INBOX_TYPE_ICON,
  talkRef,
  targetToPath,
} from './homeFormat';

function InboxRow({
  item,
  first,
  onDismiss,
  onSnooze,
  onMarkRead,
  onResolve,
}: {
  item: HomeInboxItem;
  first: boolean;
  onDismiss: (id: string) => void;
  onSnooze: (id: string, until: string) => void;
  onMarkRead: (id: string) => void;
  onResolve: (id: string) => void;
}): JSX.Element {
  const sev = INBOX_SEVERITY_BADGE[item.severity] ?? INBOX_SEVERITY_BADGE.info;
  const icon = INBOX_TYPE_ICON[item.type] ?? 'chat';
  const target = item.target as Record<string, unknown>;
  const ref = talkRef(target);
  const behavior = classifyAction(item.primaryAction, {
    to: targetToPath(target),
  });
  return (
    <div
      style={{
        display: 'flex',
        gap: 10,
        padding: '12px 0',
        borderTop: first ? 'none' : '1px solid var(--salon-line, #e6e0d1)',
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 26,
          height: 26,
          flexShrink: 0,
          borderRadius: 9999,
          display: 'grid',
          placeItems: 'center',
          background: sev.bg,
          color: sev.fg,
        }}
      >
        <CTIcon name={icon} size={12} stroke={sev.fg} strokeWidth={2} />
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            ...clampLines(2),
            fontSize: 13.5,
            fontWeight: 500,
            lineHeight: 1.35,
            color: salon.ink,
          }}
        >
          {item.title}
        </div>
        {item.summary ? (
          <div
            style={{
              ...clampLines(2),
              fontSize: 12.5,
              lineHeight: 1.4,
              marginTop: 2,
              color: salon.ink2,
            }}
          >
            {item.summary}
          </div>
        ) : null}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            marginTop: 6,
            flexWrap: 'wrap',
          }}
        >
          <span
            style={{
              fontFamily: salonFont.mono,
              fontSize: 10,
              textTransform: 'uppercase',
              letterSpacing: '0.12em',
              color: sev.fg,
            }}
          >
            {sev.label}
          </span>
          {ref ? <TalkChip talkId={ref.talkId} title={ref.title} /> : null}
          <div
            style={{
              marginLeft: 'auto',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            {behavior.kind !== 'disabled' ? (
              <ActionButton
                behavior={behavior}
                variant={item.severity === 'blocking' ? 'primary' : 'secondary'}
              />
            ) : null}
            {item.status === 'unread' ? (
              <LifecycleIconButton
                icon="eye"
                label="Mark read"
                onClick={() => onMarkRead(item.id)}
              />
            ) : null}
            <LifecycleIconButton
              icon="check"
              label="Resolve"
              onClick={() => onResolve(item.id)}
            />
            <SnoozeControl onSnooze={(until) => onSnooze(item.id, until)} />
            <LifecycleIconButton
              icon="x"
              label="Dismiss"
              onClick={() => onDismiss(item.id)}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

export function InboxPreview({
  payload,
  onDismiss,
  onSnooze,
  onMarkRead,
  onResolve,
}: {
  payload: HomeInboxPayload;
  onDismiss: (id: string) => void;
  onSnooze: (id: string, until: string) => void;
  onMarkRead: (id: string) => void;
  onResolve: (id: string) => void;
}): JSX.Element {
  const items = payload.items.slice(0, 5);
  const count = `${payload.counts.unread} unread · ${payload.counts.blocking} blocking`;
  return (
    <section aria-label="Inbox">
      <SectionHeader title="Inbox" count={count} />
      {items.length === 0 ? (
        <HomeEmpty
          icon="check"
          title="Inbox zero"
          hint="No blockers or arrivals need you right now."
        />
      ) : (
        <Card>
          {items.map((item, index) => (
            <InboxRow
              key={item.id}
              item={item}
              first={index === 0}
              onDismiss={onDismiss}
              onSnooze={onSnooze}
              onMarkRead={onMarkRead}
              onResolve={onResolve}
            />
          ))}
        </Card>
      )}
    </section>
  );
}
