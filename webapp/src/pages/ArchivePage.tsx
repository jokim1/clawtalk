/**
 * Archive — restore archived Talks. Lists `status === 'archived'` talks from the
 * `include_archived` list endpoint; each row opens the Talk or restores it via
 * the unarchive write API. Page-owned optimistic removal with entity-scoped
 * revert on failure; a 404 is treated as already-restored.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

import { Button, salon, salonFont } from '../salon';
import {
  ApiError,
  listArchivedTalks,
  unarchiveTalk,
  type Talk,
} from '../lib/api';

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; talks: Talk[] };

function formatDate(value: string): string {
  const ts = Date.parse(value);
  if (!Number.isFinite(ts)) return '';
  return new Date(ts).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export function ArchivePage({
  onRestored,
}: {
  /** Called after a successful restore so the parent can refresh the sidebar. */
  onRestored?: () => void;
} = {}): JSX.Element {
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [actionError, setActionError] = useState<string | null>(null);
  // Cancels a superseded/unmounted load so no setState fires after unmount.
  const activeLoad = useRef<{ cancelled: boolean } | null>(null);
  // Mirrors the latest ready list so a restore handler can capture the removed
  // row's index for an entity-scoped revert WITHOUT a side effect inside the
  // setState updater (updaters must stay pure — React may replay them).
  const talksRef = useRef<Talk[]>([]);

  const load = useCallback(async () => {
    if (activeLoad.current) activeLoad.current.cancelled = true;
    const signal = { cancelled: false };
    activeLoad.current = signal;
    setState({ status: 'loading' });
    try {
      const talks = await listArchivedTalks();
      if (signal.cancelled) return;
      setState({ status: 'ready', talks });
    } catch (err) {
      if (signal.cancelled) return;
      const message =
        err instanceof Error
          ? err.message
          : 'Archive is unavailable right now.';
      setState({ status: 'error', message });
    }
  }, []);

  useEffect(() => {
    void load();
    return () => {
      if (activeLoad.current) activeLoad.current.cancelled = true;
    };
  }, [load]);

  useEffect(() => {
    if (state.status === 'ready') talksRef.current = state.talks;
  }, [state]);

  const handleRestore = useCallback(
    async (talk: Talk) => {
      setActionError(null);
      // Capture the index from the committed list BEFORE the optimistic update,
      // so the updater stays pure and the revert is entity-scoped.
      const captured = talksRef.current.findIndex(
        (entry) => entry.id === talk.id,
      );
      const index = captured < 0 ? talksRef.current.length : captured;
      setState((prev) =>
        prev.status === 'ready'
          ? {
              status: 'ready',
              talks: prev.talks.filter((entry) => entry.id !== talk.id),
            }
          : prev,
      );
      try {
        await unarchiveTalk(talk.id);
        // Restored server-side: let the parent refresh the sidebar / Talk list
        // so the Talk reappears in nav without a manual reload.
        onRestored?.();
      } catch (err) {
        // 404 = the talk is already un-archived server-side; keep it removed.
        if (err instanceof ApiError && err.status === 404) {
          onRestored?.();
          return;
        }
        setState((prev) => {
          if (prev.status !== 'ready') return prev;
          if (prev.talks.some((entry) => entry.id === talk.id)) return prev;
          const talks = [...prev.talks];
          talks.splice(Math.max(0, Math.min(index, talks.length)), 0, talk);
          return { status: 'ready', talks };
        });
        setActionError('Couldn’t restore that Talk. Try again.');
      }
    },
    [onRestored],
  );

  return (
    <div
      className="ct-screen-enter ct-thin-scroll"
      style={{
        maxWidth: 820,
        margin: '0 auto',
        padding: '20px 20px 48px',
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
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
          Archive
        </h1>
        <p style={{ margin: '4px 0 0', fontSize: 13, color: salon.ink2 }}>
          Archived Talks. Restore one to bring it back into your workspace.
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

      {state.status === 'loading' ? (
        <div aria-busy="true" aria-label="Loading archive">
          {Array.from({ length: 3 }).map((_, i) => (
            <div
              key={i}
              className="ct-pulse"
              style={{
                height: 56,
                marginBottom: 10,
                borderRadius: 12,
                background: 'var(--salon-paper-2, #f4ecdb)',
              }}
            />
          ))}
        </div>
      ) : null}

      {state.status === 'error' ? (
        <ArchiveCard>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ fontSize: 13, color: salon.ink2 }}>
              {state.message}
            </div>
            <div>
              <Button variant="secondary" onClick={() => void load()}>
                Try again
              </Button>
            </div>
          </div>
        </ArchiveCard>
      ) : null}

      {state.status === 'ready' ? (
        state.talks.length === 0 ? (
          <ArchiveCard>
            <div
              style={{
                textAlign: 'center',
                padding: '24px 12px',
                color: salon.ink2,
                fontSize: 13.5,
              }}
            >
              No archived Talks.
            </div>
          </ArchiveCard>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {state.talks.map((talk) => (
              <ArchiveRow
                key={talk.id}
                talk={talk}
                onRestore={() => void handleRestore(talk)}
              />
            ))}
          </div>
        )
      ) : null}
    </div>
  );
}

function ArchiveCard({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <div
      style={{
        background: 'var(--salon-card, #ffffff)',
        border: `1px solid ${salon.line}`,
        borderRadius: 16,
        padding: 16,
      }}
    >
      {children}
    </div>
  );
}

function ArchiveRow({
  talk,
  onRestore,
}: {
  talk: Talk;
  onRestore: () => void;
}): JSX.Element {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        background: 'var(--salon-card, #ffffff)',
        border: `1px solid ${salon.line}`,
        borderRadius: 12,
        padding: '12px 14px',
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <Link
          to={`/app/talks/${encodeURIComponent(talk.id)}`}
          className="salon-btn"
          style={{
            display: 'block',
            fontSize: 14,
            fontWeight: 500,
            color: salon.ink,
            textDecoration: 'none',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {talk.title || 'Untitled Talk'}
        </Link>
        <div style={{ fontSize: 12, color: salon.ink2, marginTop: 2 }}>
          Updated {formatDate(talk.updatedAt)}
        </div>
      </div>
      <Button variant="secondary" onClick={onRestore}>
        Restore
      </Button>
    </div>
  );
}
