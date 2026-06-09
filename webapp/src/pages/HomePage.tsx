/**
 * Home — the workspace attention router (docs/07-homepage-system-design.md).
 *
 * Built on the GET /api/v1/home/* read API plus the lifecycle write endpoints.
 * Renders the stat strip, a "Do this next" curator pick (hero), a "Then maybe"
 * list, and full-width inbox + "News for your Talks" sections. Inbox
 * dismiss/snooze/mark-read/resolve, recommendation dismiss, and News
 * add-to-context/not-relevant are wired to the write API with page-owned
 * optimistic state (entity-scoped revert on failure; a 404 is treated as
 * already-gone).
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { Button, salon, salonFont } from '../salon';
import {
  ApiError,
  addHomeNewsToContext,
  dismissHomeInboxItem,
  dismissHomeRecommendation,
  getHomeSummary,
  listHomeInbox,
  listHomeNews,
  listHomeRecommendations,
  markHomeInboxItemRead,
  markHomeNewsNotRelevant,
  resolveHomeInboxItem,
  snoozeHomeInboxItem,
  type HomeInboxItem,
  type HomeInboxPayload,
  type HomeNewsItem,
  type HomeNewsPayload,
  type HomeRecommendation,
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

function recommendationTarget(
  rec: HomeRecommendation,
): Record<string, unknown> {
  const target = { ...rec.provenance, ...rec.action.payload };
  return Object.keys(target).length > 0
    ? target
    : { kind: 'recommendation', recommendationId: rec.id };
}

function recommendationCurator(
  rec: HomeRecommendation,
): HomeSummaryPayload['curator'] {
  return {
    kind: 'recommendation',
    title: rec.title,
    summary: rec.why,
    itemId: rec.id,
    target: recommendationTarget(rec),
  };
}

function inboxCurator(item: HomeInboxItem): HomeSummaryPayload['curator'] {
  return {
    kind: 'inbox',
    title: item.title,
    summary: item.summary,
    itemId: item.id,
    target: item.target,
  };
}

function newsCurator(
  news: HomeNewsPayload['items'][number],
): HomeSummaryPayload['curator'] {
  return {
    kind: 'news',
    title: news.headline,
    summary: news.whyItMatters,
    itemId: news.id,
    target: { kind: 'news', talkId: news.talkId },
  };
}

function idleCurator(): HomeSummaryPayload['curator'] {
  return {
    kind: 'idle',
    title: 'Start a Talk',
    summary:
      'Create a Talk to bring agents, sources, and follow-up work together.',
    itemId: null,
    target: null,
  };
}

function firstSevereInboxItem(
  inbox: HomeInboxPayload | null,
): HomeInboxItem | null {
  return (
    inbox?.items.find(
      (item) => item.severity === 'blocking' || item.severity === 'action',
    ) ?? null
  );
}

function recomputeSummary(
  data: HomeData,
  options?: { recommendationDelta?: number; newsDelta?: number },
): HomeData {
  if (!data.summary) return data;
  const currentCurator = data.summary.curator;
  const summaryCounts = {
    ...data.summary.counts,
    ...(data.inbox ? { inbox: data.inbox.counts } : {}),
    recommendations: Math.max(
      0,
      data.summary.counts.recommendations + (options?.recommendationDelta ?? 0),
    ),
    news: Math.max(0, data.summary.counts.news + (options?.newsDelta ?? 0)),
  };
  const hero = data.recommendations?.hero ?? null;
  const severeInbox = firstSevereInboxItem(data.inbox);
  const topNews = data.news?.items[0] ?? null;
  const curator =
    currentCurator.kind === 'talk'
      ? currentCurator
      : hero
        ? recommendationCurator(hero)
        : severeInbox
          ? inboxCurator(severeInbox)
          : topNews
            ? newsCurator(topNews)
            : idleCurator();

  return {
    ...data,
    summary: {
      ...data.summary,
      curator,
      counts: summaryCounts,
    },
  };
}

/** Remove an Inbox item and decrement the affected counts (optimistic). */
function removeInboxItem(
  inbox: HomeInboxPayload,
  id: string,
): HomeInboxPayload {
  const item = inbox.items.find((entry) => entry.id === id);
  if (!item) return inbox;
  const counts = { ...inbox.counts };
  if (item.status === 'unread') counts.unread = Math.max(0, counts.unread - 1);
  if (item.severity === 'blocking') {
    counts.blocking = Math.max(0, counts.blocking - 1);
  } else if (item.severity === 'action') {
    counts.action = Math.max(0, counts.action - 1);
  } else {
    counts.info = Math.max(0, counts.info - 1);
  }
  return {
    ...inbox,
    items: inbox.items.filter((entry) => entry.id !== id),
    counts,
  };
}

/** Mark an Inbox item read and decrement only the unread count. */
function markInboxItemRead(
  inbox: HomeInboxPayload,
  id: string,
): HomeInboxPayload {
  const item = inbox.items.find((entry) => entry.id === id);
  if (!item || item.status !== 'unread') return inbox;
  return {
    ...inbox,
    items: inbox.items.map((entry) =>
      entry.id === id ? { ...entry, status: 'read' } : entry,
    ),
    counts: {
      ...inbox.counts,
      unread: Math.max(0, inbox.counts.unread - 1),
    },
  };
}

/** Restore an Inbox item from `read` back to `unread` after a failed mark-read. */
function restoreInboxItemStatus(
  inbox: HomeInboxPayload,
  id: string,
  status: HomeInboxItem['status'],
): HomeInboxPayload {
  const item = inbox.items.find((entry) => entry.id === id);
  if (!item || item.status === status) return inbox;
  const wasReadNowUnread = item.status === 'read' && status === 'unread';
  return {
    ...inbox,
    items: inbox.items.map((entry) =>
      entry.id === id ? { ...entry, status } : entry,
    ),
    counts: wasReadNowUnread
      ? { ...inbox.counts, unread: inbox.counts.unread + 1 }
      : inbox.counts,
  };
}

/**
 * Remove a recommendation (optimistic). If the hero is removed, the first
 * then-maybe is promoted so the rail never shows an empty hero slot.
 */
function removeRecommendation(
  recs: HomeRecommendationsPayload,
  id: string,
): HomeRecommendationsPayload {
  const items = recs.items.filter((entry) => entry.id !== id);
  if (recs.hero && recs.hero.id === id) {
    return {
      ...recs,
      items,
      hero: recs.thenMaybe[0] ?? null,
      thenMaybe: recs.thenMaybe.slice(1),
    };
  }
  return {
    ...recs,
    items,
    thenMaybe: recs.thenMaybe.filter((entry) => entry.id !== id),
  };
}

/**
 * Re-insert an Inbox item at its prior index and restore its counts. Used to
 * revert a single failed mutation without touching other items that may have
 * been removed concurrently (entity-scoped revert, not a whole-state snapshot).
 */
function reinsertInboxItem(
  inbox: HomeInboxPayload,
  item: HomeInboxItem,
  index: number,
): HomeInboxPayload {
  if (inbox.items.some((entry) => entry.id === item.id)) return inbox;
  const items = [...inbox.items];
  items.splice(Math.max(0, Math.min(index, items.length)), 0, item);
  const counts = { ...inbox.counts };
  if (item.status === 'unread') counts.unread += 1;
  if (item.severity === 'blocking') counts.blocking += 1;
  else if (item.severity === 'action') counts.action += 1;
  else counts.info += 1;
  return { ...inbox, items, counts };
}

/**
 * A 404 means the server already considers the item gone (terminal or deleted),
 * so the optimistic removal was correct — keep it removed instead of reverting.
 */
function isAlreadyGone(err: unknown): boolean {
  return err instanceof ApiError && err.status === 404;
}

const ACTION_ERROR_MESSAGE = 'Couldn’t update that item. Try again.';

/** Restore a single dismissed recommendation (entity-scoped revert). */
function restoreRecommendation(
  recs: HomeRecommendationsPayload,
  rec: HomeRecommendation,
  wasHero: boolean,
): HomeRecommendationsPayload {
  const present =
    recs.hero?.id === rec.id ||
    recs.items.some((entry) => entry.id === rec.id) ||
    recs.thenMaybe.some((entry) => entry.id === rec.id);
  if (present) return recs;
  const items = [rec, ...recs.items];
  if (wasHero) {
    return {
      ...recs,
      items,
      hero: rec,
      thenMaybe: recs.hero ? [recs.hero, ...recs.thenMaybe] : recs.thenMaybe,
    };
  }
  return { ...recs, items, thenMaybe: [rec, ...recs.thenMaybe] };
}

function removeNewsItem(news: HomeNewsPayload, id: string): HomeNewsPayload {
  if (!news.items.some((entry) => entry.id === id)) return news;
  return { ...news, items: news.items.filter((entry) => entry.id !== id) };
}

function reinsertNewsItem(
  news: HomeNewsPayload,
  item: HomeNewsItem,
  index: number,
): HomeNewsPayload {
  if (news.items.some((entry) => entry.id === item.id)) return news;
  const items = [...news.items];
  items.splice(Math.max(0, Math.min(index, items.length)), 0, item);
  return { ...news, items };
}

export function HomePage(): JSX.Element {
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  // Tracks the in-flight load so a retry (or unmount) cancels the prior
  // request and no setState fires on an unmounted component.
  const activeLoad = useRef<{ cancelled: boolean } | null>(null);
  // Mirrors the latest ready data so a mutation handler can capture the exact
  // entity it removes (for an entity-scoped revert on failure) without a full
  // reload + skeleton flash.
  const readyDataRef = useRef<HomeData | null>(null);
  // Surfaced when an optimistic write fails for a real reason (network / 5xx /
  // rate limit) so the revert isn't silent. A 404 is treated as success.
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (activeLoad.current) activeLoad.current.cancelled = true;
    const signal = { cancelled: false };
    activeLoad.current = signal;

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
    void load();
    return () => {
      if (activeLoad.current) activeLoad.current.cancelled = true;
    };
  }, [load]);

  useEffect(() => {
    if (state.status === 'ready') readyDataRef.current = state.data;
  }, [state]);

  // Optimistically remove an Inbox item, then revert just that item (at its
  // prior index) if the write fails — never a whole-state snapshot, so an
  // overlapping mutation can't be clobbered by a sibling's failure.
  const mutateInbox = useCallback(
    async (id: string, run: () => Promise<unknown>) => {
      const inbox = readyDataRef.current?.inbox;
      const index = inbox?.items.findIndex((entry) => entry.id === id) ?? -1;
      const removed: HomeInboxItem | undefined =
        index >= 0 ? inbox?.items[index] : undefined;
      setActionError(null);
      setState((prev) =>
        prev.status === 'ready' && prev.data.inbox
          ? {
              status: 'ready',
              data: recomputeSummary({
                ...prev.data,
                inbox: removeInboxItem(prev.data.inbox, id),
              }),
            }
          : prev,
      );
      try {
        await run();
      } catch (err) {
        if (isAlreadyGone(err)) return;
        if (removed) {
          setState((prev) =>
            prev.status === 'ready' && prev.data.inbox
              ? {
                  status: 'ready',
                  data: recomputeSummary({
                    ...prev.data,
                    inbox: reinsertInboxItem(prev.data.inbox, removed, index),
                  }),
                }
              : prev,
          );
        }
        setActionError(ACTION_ERROR_MESSAGE);
      }
    },
    [],
  );

  const handleDismissInbox = useCallback(
    (id: string) => void mutateInbox(id, () => dismissHomeInboxItem(id)),
    [mutateInbox],
  );

  const handleSnoozeInbox = useCallback(
    (id: string, until: string) =>
      void mutateInbox(id, () => snoozeHomeInboxItem(id, until)),
    [mutateInbox],
  );

  const handleResolveInbox = useCallback(
    (id: string) => void mutateInbox(id, () => resolveHomeInboxItem(id)),
    [mutateInbox],
  );

  const handleMarkInboxRead = useCallback(async (id: string) => {
    const inbox = readyDataRef.current?.inbox;
    const currentStatus = inbox?.items.find((entry) => entry.id === id)?.status;
    setActionError(null);
    setState((prev) =>
      prev.status === 'ready' && prev.data.inbox
        ? {
            status: 'ready',
            data: recomputeSummary({
              ...prev.data,
              inbox: markInboxItemRead(prev.data.inbox, id),
            }),
          }
        : prev,
    );
    try {
      await markHomeInboxItemRead(id);
    } catch (err) {
      if (isAlreadyGone(err)) return;
      if (currentStatus) {
        setState((prev) =>
          prev.status === 'ready' && prev.data.inbox
            ? {
                status: 'ready',
                data: recomputeSummary({
                  ...prev.data,
                  inbox: restoreInboxItemStatus(
                    prev.data.inbox,
                    id,
                    currentStatus,
                  ),
                }),
              }
            : prev,
        );
      }
      setActionError(ACTION_ERROR_MESSAGE);
    }
  }, []);

  const handleDismissRecommendation = useCallback(async (id: string) => {
    const recs = readyDataRef.current?.recommendations;
    const wasHero = recs?.hero?.id === id;
    const rec: HomeRecommendation | undefined = wasHero
      ? (recs?.hero ?? undefined)
      : (recs?.items.find((entry) => entry.id === id) ??
        recs?.thenMaybe.find((entry) => entry.id === id));
    setActionError(null);
    setState((prev) =>
      prev.status === 'ready' && prev.data.recommendations
        ? {
            status: 'ready',
            data: recomputeSummary(
              {
                ...prev.data,
                recommendations: removeRecommendation(
                  prev.data.recommendations,
                  id,
                ),
              },
              { recommendationDelta: -1 },
            ),
          }
        : prev,
    );
    try {
      await dismissHomeRecommendation(id);
    } catch (err) {
      if (isAlreadyGone(err)) return;
      if (rec) {
        setState((prev) =>
          prev.status === 'ready' && prev.data.recommendations
            ? {
                status: 'ready',
                data: recomputeSummary(
                  {
                    ...prev.data,
                    recommendations: restoreRecommendation(
                      prev.data.recommendations,
                      rec,
                      wasHero ?? false,
                    ),
                  },
                  { recommendationDelta: 1 },
                ),
              }
            : prev,
        );
      }
      setActionError(ACTION_ERROR_MESSAGE);
    }
  }, []);

  const mutateNews = useCallback(
    async (id: string, run: () => Promise<unknown>) => {
      const news = readyDataRef.current?.news;
      const index = news?.items.findIndex((entry) => entry.id === id) ?? -1;
      const removed: HomeNewsItem | undefined =
        index >= 0 ? news?.items[index] : undefined;
      setActionError(null);
      setState((prev) =>
        prev.status === 'ready' && prev.data.news
          ? {
              status: 'ready',
              data: recomputeSummary(
                {
                  ...prev.data,
                  news: removeNewsItem(prev.data.news, id),
                },
                { newsDelta: -1 },
              ),
            }
          : prev,
      );
      try {
        await run();
      } catch (err) {
        if (isAlreadyGone(err)) return;
        if (removed) {
          setState((prev) =>
            prev.status === 'ready' && prev.data.news
              ? {
                  status: 'ready',
                  data: recomputeSummary(
                    {
                      ...prev.data,
                      news: reinsertNewsItem(prev.data.news, removed, index),
                    },
                    { newsDelta: 1 },
                  ),
                }
              : prev,
          );
        }
        setActionError(ACTION_ERROR_MESSAGE);
      }
    },
    [],
  );

  const handleAddNewsToContext = useCallback(
    (id: string) => void mutateNews(id, () => addHomeNewsToContext(id)),
    [mutateNews],
  );

  const handleMarkNewsNotRelevant = useCallback(
    (id: string) => void mutateNews(id, () => markHomeNewsNotRelevant(id)),
    [mutateNews],
  );

  return (
    <div
      className="ct-screen-enter ct-thin-scroll"
      style={{
        // width:100% is load-bearing: in the .app-main-content grid cell, the
        // auto horizontal margins would otherwise trigger shrink-to-fit and the
        // column collapses to content width (narrow when the page is empty).
        width: '100%',
        maxWidth: 1240,
        margin: '0 auto',
        padding: '28px 36px 48px',
        display: 'flex',
        flexDirection: 'column',
        gap: 28,
      }}
    >
      <header>
        <h1
          style={{
            margin: 0,
            fontFamily: salonFont.serif,
            fontSize: 40,
            lineHeight: 1.05,
            fontWeight: 500,
            color: salon.ink,
          }}
        >
          Home
        </h1>
        <p style={{ margin: '6px 0 0', fontSize: 14, color: salon.ink2 }}>
          What needs you across your workspace.
        </p>
      </header>

      {actionError ? (
        <div
          role="alert"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '10px 14px',
            borderRadius: 12,
            background: '#fbecec',
            color: '#7b2a30',
            fontSize: 13,
          }}
        >
          <span style={{ flex: 1 }}>{actionError}</span>
          <button
            type="button"
            onClick={() => setActionError(null)}
            aria-label="Dismiss error"
            className="salon-btn"
            style={{
              border: 'none',
              background: 'transparent',
              color: '#7b2a30',
              cursor: 'pointer',
              fontSize: 13,
            }}
          >
            Dismiss
          </button>
        </div>
      ) : null}

      {state.status === 'loading' ? <HomeLoading /> : null}
      {state.status === 'error' ? (
        <HomeErrorCard message={state.message} onRetry={() => void load()} />
      ) : null}
      {state.status === 'ready' ? (
        <HomeContent
          data={state.data}
          onDismissInbox={handleDismissInbox}
          onSnoozeInbox={handleSnoozeInbox}
          onMarkInboxRead={handleMarkInboxRead}
          onResolveInbox={handleResolveInbox}
          onDismissRecommendation={handleDismissRecommendation}
          onAddNewsToContext={handleAddNewsToContext}
          onMarkNewsNotRelevant={handleMarkNewsNotRelevant}
        />
      ) : null}
    </div>
  );
}

function HomeContent({
  data,
  onDismissInbox,
  onSnoozeInbox,
  onMarkInboxRead,
  onResolveInbox,
  onDismissRecommendation,
  onAddNewsToContext,
  onMarkNewsNotRelevant,
}: {
  data: HomeData;
  onDismissInbox: (id: string) => void;
  onSnoozeInbox: (id: string, until: string) => void;
  onMarkInboxRead: (id: string) => void;
  onResolveInbox: (id: string) => void;
  onDismissRecommendation: (id: string) => void;
  onAddNewsToContext: (id: string) => void;
  onMarkNewsNotRelevant: (id: string) => void;
}): JSX.Element {
  const recs = data.recommendations;
  const hero = recs?.hero ?? null;
  const thenMaybe = recs?.thenMaybe ?? [];

  return (
    <>
      {data.summary ? <StatStrip stats={data.summary.stats} /> : null}

      {/* Do this next — the single curator pick (hero), per the design. When
          there's no recommendation, the curator summary doubles as the idle
          "start a Talk" prompt instead of a separate top card. */}
      <section aria-label="Do this next">
        <SectionHeader
          title="Do this next"
          count={hero ? 'curator pick' : undefined}
        />
        {hero ? (
          <RecommendationCard
            rec={hero}
            variant="hero"
            onDismiss={onDismissRecommendation}
          />
        ) : data.summary ? (
          <CuratorCard curator={data.summary.curator} />
        ) : (
          <HomeEmpty
            icon="sparkle"
            title="No recommendations yet"
            hint="As your Talks progress, the curator will suggest the next move here."
          />
        )}
      </section>

      {/* Then maybe — the secondary recommendations, stacked full-width. */}
      {thenMaybe.length > 0 ? (
        <section aria-label="Then maybe">
          <SectionHeader
            title="Then maybe"
            count={`${thenMaybe.length} more`}
          />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {thenMaybe.map((rec) => (
              <RecommendationCard
                key={rec.id}
                rec={rec}
                variant="compact"
                onDismiss={onDismissRecommendation}
              />
            ))}
          </div>
        </section>
      ) : null}

      {/* Inbox + News stack full-width (design has no side-by-side split). */}
      <InboxPreview
        payload={data.inbox ?? EMPTY_INBOX}
        onDismiss={onDismissInbox}
        onSnooze={onSnoozeInbox}
        onMarkRead={onMarkInboxRead}
        onResolve={onResolveInbox}
      />
      <NewsPreview
        payload={data.news ?? EMPTY_NEWS}
        onAddToContext={onAddNewsToContext}
        onNotRelevant={onMarkNewsNotRelevant}
      />
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
