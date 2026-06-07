/**
 * Home — the workspace attention router (docs/07-homepage-system-design.md).
 *
 * Read-only v1 built on the GET /api/v1/home/* API. Renders the curator
 * summary, stat strip, recommendations (hero + then-maybe), and an inbox/news
 * split. Navigation-shaped actions work today; mutation actions (dismiss /
 * snooze / resolve / add-to-context) render disabled until the Home write API
 * lands (see classifyAction in components/home/homeFormat).
 */
import { useCallback, useEffect, useState } from 'react';

import { Button, salon, salonFont } from '../salon';
import {
  getHomeSummary,
  listHomeInbox,
  listHomeNews,
  listHomeRecommendations,
  type HomeInboxPayload,
  type HomeNewsPayload,
  type HomeRecommendationsPayload,
  type HomeSummaryPayload,
} from '../lib/api';
import { CuratorCard } from '../components/home/CuratorCard';
import { StatStrip } from '../components/home/StatStrip';
import { RecommendationCard } from '../components/home/RecommendationCard';
import { InboxPreview } from '../components/home/InboxPreview';
import { NewsPreview } from '../components/home/NewsPreview';
import {
  Card,
  HomeEmpty,
  SectionHeader,
  SkeletonCard,
  SkeletonLine,
} from '../components/home/HomeKit';

type HomeData = {
  summary: HomeSummaryPayload | null;
  inbox: HomeInboxPayload | null;
  recommendations: HomeRecommendationsPayload | null;
  news: HomeNewsPayload | null;
};

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; data: HomeData };

const EMPTY_INBOX: HomeInboxPayload = {
  items: [],
  counts: { unread: 0, blocking: 0, action: 0, info: 0 },
  nextCursor: null,
  algorithmVersion: '',
};

const EMPTY_NEWS: HomeNewsPayload = {
  items: [],
  nextCursor: null,
  algorithmVersion: '',
};

export function HomePage(): JSX.Element {
  const [state, setState] = useState<LoadState>({ status: 'loading' });

  const load = useCallback(async (signal: { cancelled: boolean }) => {
    setState({ status: 'loading' });
    // The summary is the spine (curator + stats); a failure there fails the
    // page. The three list calls degrade independently to empty sections.
    const [summary, inbox, recommendations, news] = await Promise.allSettled([
      getHomeSummary(),
      listHomeInbox({ limit: 5 }),
      listHomeRecommendations({ limit: 12 }),
      listHomeNews({ limit: 6 }),
    ]);
    if (signal.cancelled) return;

    if (summary.status === 'rejected') {
      const message =
        summary.reason instanceof Error
          ? summary.reason.message
          : 'Home is unavailable right now.';
      setState({ status: 'error', message });
      return;
    }

    setState({
      status: 'ready',
      data: {
        summary: summary.value,
        inbox: inbox.status === 'fulfilled' ? inbox.value : null,
        recommendations:
          recommendations.status === 'fulfilled' ? recommendations.value : null,
        news: news.status === 'fulfilled' ? news.value : null,
      },
    });
  }, []);

  useEffect(() => {
    const signal = { cancelled: false };
    void load(signal);
    return () => {
      signal.cancelled = true;
    };
  }, [load]);

  return (
    <div
      className="ct-screen-enter ct-thin-scroll"
      style={{
        maxWidth: 980,
        margin: '0 auto',
        padding: '20px 20px 48px',
        display: 'flex',
        flexDirection: 'column',
        gap: 20,
      }}
    >
      <header>
        <h1
          style={{
            margin: 0,
            fontFamily: salonFont.serif,
            fontSize: 26,
            fontWeight: 500,
            color: salon.ink,
          }}
        >
          Home
        </h1>
        <p style={{ margin: '4px 0 0', fontSize: 13, color: salon.ink2 }}>
          What needs you across your workspace.
        </p>
      </header>

      {state.status === 'loading' ? <HomeLoading /> : null}
      {state.status === 'error' ? (
        <HomeErrorCard
          message={state.message}
          onRetry={() => void load({ cancelled: false })}
        />
      ) : null}
      {state.status === 'ready' ? <HomeContent data={state.data} /> : null}
    </div>
  );
}

function HomeContent({ data }: { data: HomeData }): JSX.Element {
  const recs = data.recommendations;
  const hero = recs?.hero ?? null;
  const thenMaybe = recs?.thenMaybe ?? [];
  const hasRecs = Boolean(hero) || thenMaybe.length > 0;

  return (
    <>
      {data.summary ? <CuratorCard curator={data.summary.curator} /> : null}
      {data.summary ? <StatStrip stats={data.summary.stats} /> : null}

      <section aria-label="Recommendations">
        <SectionHeader
          title="Recommendations"
          count={
            recs ? `${(hero ? 1 : 0) + thenMaybe.length} for you` : undefined
          }
        />
        {hasRecs ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {hero ? <RecommendationCard rec={hero} variant="hero" /> : null}
            {thenMaybe.length > 0 ? (
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
                  gap: 12,
                }}
              >
                {thenMaybe.map((rec) => (
                  <RecommendationCard
                    key={rec.id}
                    rec={rec}
                    variant="compact"
                  />
                ))}
              </div>
            ) : null}
          </div>
        ) : (
          <HomeEmpty
            icon="sparkle"
            title="No recommendations yet"
            hint="As your Talks progress, the curator will suggest the next move here."
          />
        )}
      </section>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
          gap: 20,
          alignItems: 'start',
        }}
      >
        <InboxPreview payload={data.inbox ?? EMPTY_INBOX} />
        <NewsPreview payload={data.news ?? EMPTY_NEWS} />
      </div>
    </>
  );
}

function HomeLoading(): JSX.Element {
  return (
    <div
      aria-busy="true"
      aria-label="Loading home"
      style={{ display: 'flex', flexDirection: 'column', gap: 20 }}
    >
      <Card>
        <SkeletonLine width="30%" />
        <div style={{ height: 8 }} />
        <SkeletonLine width="80%" />
      </Card>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
          gap: 12,
        }}
      >
        {Array.from({ length: 4 }).map((_, i) => (
          <SkeletonCard key={i} lines={1} />
        ))}
      </div>
      <SkeletonCard lines={3} />
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
          gap: 20,
        }}
      >
        <SkeletonCard lines={3} />
        <SkeletonCard lines={3} />
      </div>
    </div>
  );
}

function HomeErrorCard({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}): JSX.Element {
  return (
    <Card>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div
          style={{
            fontFamily: salonFont.serif,
            fontSize: 17,
            color: salon.ink,
          }}
        >
          Home couldn’t load
        </div>
        <div style={{ fontSize: 13, color: salon.ink2 }}>{message}</div>
        <div>
          <Button variant="secondary" onClick={onRetry}>
            Try again
          </Button>
        </div>
      </div>
    </Card>
  );
}
