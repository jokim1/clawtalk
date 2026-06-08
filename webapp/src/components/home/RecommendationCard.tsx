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
  const isHero = variant === 'hero';
  const titleSize = isHero ? 28 : 17;

  return (
    <Card
      accentRail={isHero || rec.priority === 'decide'}
      style={
        isHero
          ? {
              padding: 24,
              boxShadow: `inset 3px 0 0 var(--salon-accent, ${salon.accent}), 0 12px 32px rgba(31,27,22,0.06)`,
            }
          : undefined
      }
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: isHero ? 16 : 10,
        }}
      >
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
                lineHeight: isHero ? 1.15 : 1.3,
                color: salon.ink,
              }}
            >
              {rec.title}
            </div>
            {rec.why ? (
              <div
                style={{
                  ...clampLines(3),
                  fontFamily: isHero ? salonFont.serif : undefined,
                  fontStyle: isHero ? 'italic' : undefined,
                  fontSize: isHero ? 15 : 12.5,
                  lineHeight: isHero ? 1.55 : 1.4,
                  marginTop: isHero ? 8 : 4,
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
