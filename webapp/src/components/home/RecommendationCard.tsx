/**
 * Recommendation card — hero + then-maybe follow-ups (docs/07 §7.9). Ported
 * from RecommendationCard in prototype/home-shared.jsx. The primary action is
 * routed when it resolves to a Talk/URL; every card also carries a Dismiss
 * control wired to the Home write API (the parent owns optimistic removal).
 */
import { salon, salonFont } from '../../salon';
import type { HomeRecommendation } from '../../lib/api';
import {
  ActionButton,
  Badge,
  Card,
  clampLines,
  KindGlyph,
  LifecycleIconButton,
  TalkChip,
} from './HomeKit';
import {
  classifyAction,
  REC_KIND_ICON,
  REC_PRIORITY_BADGE,
  talkRef,
  targetToPath,
} from './homeFormat';

export function RecommendationCard({
  rec,
  variant = 'hero',
  onDismiss,
}: {
  rec: HomeRecommendation;
  variant?: 'hero' | 'compact';
  onDismiss: (id: string) => void;
}): JSX.Element {
  const badge = REC_PRIORITY_BADGE[rec.priority] ?? REC_PRIORITY_BADGE.tidy;
  const icon = REC_KIND_ICON[rec.kind] ?? 'sparkle';
  const ref = talkRef(rec.provenance);
  const behavior = classifyAction(rec.action, {
    to: ref
      ? `/app/talks/${encodeURIComponent(ref.talkId)}`
      : targetToPath(rec.provenance),
  });
  const titleSize = variant === 'hero' ? 18 : 15;

  return (
    <Card accentRail={rec.priority === 'decide'}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Badge tone={badge} />
          <span
            style={{
              fontFamily: salonFont.mono,
              fontSize: 10.5,
              textTransform: 'uppercase',
              letterSpacing: '0.14em',
              color: salon.ink2,
            }}
          >
            {rec.kind.replace(/-/g, ' ')}
          </span>
        </div>

        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
          <KindGlyph icon={icon} size={variant === 'hero' ? 28 : 24} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                ...clampLines(2),
                fontFamily: salonFont.serif,
                fontSize: titleSize,
                lineHeight: 1.3,
                color: salon.ink,
              }}
            >
              {rec.title}
            </div>
            {rec.why ? (
              <div
                style={{
                  ...clampLines(3),
                  fontSize: 12.5,
                  lineHeight: 1.4,
                  marginTop: 4,
                  color: salon.ink2,
                }}
              >
                {rec.why}
              </div>
            ) : null}
          </div>
        </div>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            flexWrap: 'wrap',
          }}
        >
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
                size={variant === 'hero' ? 'md' : 'sm'}
              />
            ) : null}
            <LifecycleIconButton
              icon="x"
              label="Dismiss recommendation"
              onClick={() => onDismiss(rec.id)}
            />
          </div>
        </div>
      </div>
    </Card>
  );
}
