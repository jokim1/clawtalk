/**
 * Documents — workspace document index over the native `/api/v1/documents`
 * list route, in the design's dense-table layout (docs/prototypes
 * prototype/documents.jsx DocumentsScreen): a stats strip plus a sortable
 * table of every document. Each row opens the native document viewer.
 * Read-only: documents are produced by agent runs, jobs, and Forge, so there
 * is no create affordance here — the surface is for reviewing and resolving.
 *
 * The document list is the spine; the talks sidebar tree is non-blocking
 * enrichment that resolves linked-Talk titles and folder names (a document's
 * folder is the folder of the Talk that owns it).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { Button, CTIcon, salon, salonFont } from '../salon';
import {
  getTalkSidebar,
  listDocuments,
  type NativeDocumentSummary,
  type TalkSidebarTree,
} from '../lib/api';
import { relativeAge } from '../components/home/homeFormat';

type TalkMaps = {
  titles: Map<string, string>;
  folders: Map<string, string>;
  folderTitles: Map<string, string>;
};

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | {
      status: 'ready';
      documents: NativeDocumentSummary[];
      talks: TalkMaps | null;
    };

type SortKey = 'title' | 'format' | 'lastEditAt' | 'wordCount';
type SortDir = 'asc' | 'desc';

function buildTalkMaps(tree: TalkSidebarTree): TalkMaps {
  const titles = new Map<string, string>();
  const folders = new Map<string, string>();
  const folderTitles = new Map<string, string>();
  for (const item of tree.items) {
    if (item.type === 'talk') {
      titles.set(item.id, item.title);
    } else {
      folderTitles.set(item.id, item.title);
      for (const talk of item.talks) {
        titles.set(talk.id, talk.title);
        folders.set(talk.id, item.title);
      }
    }
  }
  return { titles, folders, folderTitles };
}

/** A document's folder: its own folderId first, else the linked Talk's. */
function resolveFolder(
  doc: NativeDocumentSummary,
  talks: TalkMaps | null,
): string | null {
  if (!talks) return null;
  if (doc.folderId) return talks.folderTitles.get(doc.folderId) ?? null;
  if (doc.primaryTalkId) return talks.folders.get(doc.primaryTalkId) ?? null;
  return null;
}

/** Activity timestamp matching the API's coalesce(last_edit, updated, created). */
function activityIso(doc: NativeDocumentSummary): string | null {
  return doc.lastEditAt ?? doc.updatedAt ?? doc.createdAt ?? null;
}

function compareDocs(
  a: NativeDocumentSummary,
  b: NativeDocumentSummary,
  key: SortKey,
): number {
  if (key === 'title') return a.title.localeCompare(b.title);
  if (key === 'format') return a.format.localeCompare(b.format);
  if (key === 'wordCount') return a.wordCount - b.wordCount;
  const aIso = activityIso(a);
  const bIso = activityIso(b);
  const at = aIso ? Date.parse(aIso) : Number.NEGATIVE_INFINITY;
  const bt = bIso ? Date.parse(bIso) : Number.NEGATIVE_INFINITY;
  return at - bt;
}

// Column widths kept consistent between the header and rows.
const COLS = {
  format: 64,
  folder: 150,
  talk: 220,
  activity: 130,
  words: 64,
} as const;

export function DocumentsPage(): JSX.Element {
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [query, setQuery] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('lastEditAt');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const activeLoad = useRef<{ cancelled: boolean } | null>(null);

  const load = useCallback(async () => {
    if (activeLoad.current) activeLoad.current.cancelled = true;
    const signal = { cancelled: false };
    activeLoad.current = signal;
    setState({ status: 'loading' });

    let documents: NativeDocumentSummary[];
    try {
      documents = await listDocuments();
    } catch (err) {
      if (signal.cancelled) return;
      const message =
        err instanceof Error
          ? err.message
          : 'Documents are unavailable right now.';
      setState({ status: 'error', message });
      return;
    }
    if (signal.cancelled) return;
    setState({ status: 'ready', documents, talks: null });

    // Non-blocking enrichment: linked-Talk titles + folder names. On failure
    // the table renders with generic chip labels and "—" folders.
    try {
      const tree = await getTalkSidebar();
      if (signal.cancelled) return;
      setState((prev) =>
        prev.status === 'ready' ? { ...prev, talks: buildTalkMaps(tree) } : prev,
      );
    } catch {
      // Enrichment only.
    }
  }, []);

  useEffect(() => {
    void load();
    return () => {
      if (activeLoad.current) activeLoad.current.cancelled = true;
    };
  }, [load]);

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDir((dir) => (dir === 'desc' ? 'asc' : 'desc'));
    } else {
      setSortKey(key);
      setSortDir('desc');
    }
  };

  const rows = useMemo(() => {
    if (state.status !== 'ready') return [];
    let list = state.documents;
    const q = query.trim().toLowerCase();
    if (q) {
      list = list.filter((doc) => {
        const talkTitle = doc.primaryTalkId
          ? (state.talks?.titles.get(doc.primaryTalkId) ?? '')
          : '';
        const folder = resolveFolder(doc, state.talks) ?? '';
        return (
          doc.title.toLowerCase().includes(q) ||
          talkTitle.toLowerCase().includes(q) ||
          folder.toLowerCase().includes(q)
        );
      });
    }
    const sorted = [...list].sort((a, b) => compareDocs(a, b, sortKey));
    if (sortDir === 'desc') sorted.reverse();
    return sorted;
  }, [state, query, sortKey, sortDir]);

  return (
    <div
      className="ct-screen-enter ct-thin-scroll"
      style={{
        width: '100%',
        maxWidth: 1320,
        margin: '0 auto',
        padding: '28px 36px 48px',
        display: 'flex',
        flexDirection: 'column',
        gap: 24,
      }}
    >
      <header
        style={{
          display: 'flex',
          alignItems: 'flex-end',
          gap: 16,
          flexWrap: 'wrap',
        }}
      >
        <div style={{ flex: 1, minWidth: 240 }}>
          <h1
            style={{
              margin: 0,
              fontFamily: salonFont.serif,
              fontSize: 36,
              lineHeight: 1.05,
              fontWeight: 500,
              letterSpacing: '-0.01em',
              color: salon.ink,
            }}
          >
            Documents
          </h1>
          <p
            style={{
              margin: '8px 0 0',
              fontSize: 14,
              maxWidth: 660,
              color: salon.ink2,
            }}
          >
            Every doc your agents have touched. A doc can live on its own, or
            be linked to the one Talk that owns it.
          </p>
        </div>
        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            height: 34,
            padding: '0 10px',
            borderRadius: 10,
            background: salon.card,
            border: `1px solid ${salon.line}`,
          }}
        >
          <CTIcon name="search" size={13} stroke={salon.ink2} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter by title, folder, or linked Talk"
            aria-label="Filter documents"
            style={{
              width: 250,
              border: 'none',
              outline: 'none',
              background: 'transparent',
              fontFamily: salonFont.sans,
              fontSize: 12.5,
              color: salon.ink,
            }}
          />
        </label>
      </header>

      {state.status === 'loading' ? (
        <div aria-busy="true" aria-label="Loading documents">
          {Array.from({ length: 3 }).map((_, i) => (
            <div
              key={i}
              className="ct-pulse"
              style={{
                height: 64,
                marginBottom: 10,
                borderRadius: 12,
                background: 'var(--salon-paper-2, #f4ecdb)',
              }}
            />
          ))}
        </div>
      ) : null}

      {state.status === 'error' ? (
        <IndexCard>
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
        </IndexCard>
      ) : null}

      {state.status === 'ready' ? (
        state.documents.length === 0 ? (
          <IndexCard>
            <div
              style={{
                textAlign: 'center',
                padding: '24px 12px',
                color: salon.ink2,
                fontSize: 13.5,
              }}
            >
              No documents yet. When an agent drafts a document in a Talk, it
              shows up here.
            </div>
          </IndexCard>
        ) : (
          <>
            <StatsStrip documents={state.documents} />
            <IndexCard style={{ padding: 0, overflowX: 'auto' }}>
              <div style={{ minWidth: 880 }}>
                <TableHeader
                  sortKey={sortKey}
                  sortDir={sortDir}
                  onToggle={toggleSort}
                />
                {rows.length === 0 ? (
                  <div
                    style={{
                      padding: '36px 16px',
                      textAlign: 'center',
                      fontSize: 13,
                      color: salon.ink2,
                    }}
                  >
                    No docs match{' '}
                    <span style={{ fontFamily: salonFont.mono }}>
                      “{query}”
                    </span>
                    .
                  </div>
                ) : (
                  rows.map((doc) => (
                    <DocRow key={doc.id} doc={doc} talks={state.talks} />
                  ))
                )}
              </div>
            </IndexCard>
            <div
              style={{
                textAlign: 'center',
                fontSize: 11.5,
                color: salon.ink2,
              }}
            >
              {rows.length} of {state.documents.length} shown · sorted by{' '}
              <span style={{ fontFamily: salonFont.mono }}>
                {sortKey} {sortDir}
              </span>
            </div>
          </>
        )
      ) : null}
    </div>
  );
}

function IndexCard({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: React.CSSProperties;
}): JSX.Element {
  return (
    <div
      style={{
        background: salon.card,
        border: `1px solid ${salon.line}`,
        borderRadius: 16,
        padding: 16,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

function StatsStrip({
  documents,
}: {
  documents: NativeDocumentSummary[];
}): JSX.Element {
  const linked = documents.filter((d) => d.primaryTalkId).length;
  const words = documents.reduce((n, d) => n + d.wordCount, 0);
  const pending = documents.reduce((n, d) => n + d.pendingEditCount, 0);
  const latest = documents.reduce<NativeDocumentSummary | null>((best, d) => {
    const ts = activityIso(d);
    if (!ts) return best;
    const bestTs = best ? activityIso(best) : null;
    if (!bestTs) return d;
    return Date.parse(ts) > Date.parse(bestTs) ? d : best;
  }, null);

  const cells = [
    {
      label: 'Documents',
      value: String(documents.length),
      sub: `${linked} linked · ${documents.length - linked} loose`,
    },
    {
      label: 'Words',
      value: words.toLocaleString(),
      sub: 'across all docs',
    },
    {
      label: 'Pending edits',
      value: String(pending),
      sub: 'awaiting your review',
    },
    {
      label: 'Last activity',
      value: latest ? (relativeAge(activityIso(latest)) ?? '—') : '—',
      sub: latest ? latest.title || 'Untitled document' : 'no edits yet',
    },
  ];

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
        gap: 12,
      }}
    >
      {cells.map((cell) => (
        <div
          key={cell.label}
          style={{
            padding: 16,
            borderRadius: 16,
            background: salon.card,
            border: `1px solid ${salon.line}`,
          }}
        >
          <div
            style={{
              fontFamily: salonFont.mono,
              fontSize: 10.5,
              textTransform: 'uppercase',
              letterSpacing: '0.18em',
              color: salon.ink2,
            }}
          >
            {cell.label}
          </div>
          <div
            style={{
              marginTop: 6,
              fontFamily: salonFont.serif,
              fontSize: 26,
              lineHeight: 1,
              letterSpacing: '-0.01em',
              color: salon.ink,
            }}
          >
            {cell.value}
          </div>
          <div
            style={{
              marginTop: 8,
              fontSize: 11.5,
              color: salon.ink2,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {cell.sub}
          </div>
        </div>
      ))}
    </div>
  );
}

const HEADER_LABELS: Array<{
  key: SortKey | null;
  label: string;
  width?: number;
  align?: 'right';
}> = [
  { key: 'title', label: 'Title' },
  { key: 'format', label: 'Fmt', width: COLS.format },
  { key: null, label: 'Folder', width: COLS.folder },
  { key: null, label: 'Linked Talk', width: COLS.talk },
  { key: 'lastEditAt', label: 'Last activity', width: COLS.activity },
  { key: 'wordCount', label: 'Words', width: COLS.words, align: 'right' },
];

function TableHeader({
  sortKey,
  sortDir,
  onToggle,
}: {
  sortKey: SortKey;
  sortDir: SortDir;
  onToggle: (key: SortKey) => void;
}): JSX.Element {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        height: 40,
        padding: '0 16px',
        borderBottom: `1px solid ${salon.line}`,
      }}
    >
      {HEADER_LABELS.map((col) => {
        const style: React.CSSProperties = {
          width: col.width,
          flex: col.width ? undefined : 1,
          minWidth: col.width ? undefined : 220,
          flexShrink: 0,
          textAlign: col.align ?? 'left',
          fontFamily: salonFont.mono,
          fontSize: 11,
          textTransform: 'uppercase',
          letterSpacing: '0.16em',
          color: salon.ink2,
        };
        if (!col.key) {
          return (
            <span key={col.label} style={style}>
              {col.label}
            </span>
          );
        }
        const active = sortKey === col.key;
        return (
          <button
            key={col.label}
            type="button"
            onClick={() => onToggle(col.key as SortKey)}
            className="salon-btn"
            style={{
              ...style,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: col.align === 'right' ? 'flex-end' : 'flex-start',
              gap: 4,
              border: 'none',
              background: 'transparent',
              cursor: 'pointer',
              padding: 0,
            }}
          >
            {col.label}
            {active ? (
              <span aria-hidden="true" style={{ color: salon.ink }}>
                {sortDir === 'desc' ? '↓' : '↑'}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

const FORMAT_BADGE: Record<string, { bg: string; fg: string; label: string }> =
  {
    markdown: { bg: salon.accent, fg: '#ffffff', label: 'MD' },
    html: { bg: '#3d5688', fg: '#ffffff', label: 'HTML' },
  };

function DocRow({
  doc,
  talks,
}: {
  doc: NativeDocumentSummary;
  talks: TalkMaps | null;
}): JSX.Element {
  const navigate = useNavigate();
  const href = `/app/documents/${encodeURIComponent(doc.id)}`;
  const talkTitle = doc.primaryTalkId
    ? (talks?.titles.get(doc.primaryTalkId) ?? 'Open Talk')
    : null;
  const folder = resolveFolder(doc, talks);
  const badge = FORMAT_BADGE[doc.format] ?? FORMAT_BADGE.markdown;

  return (
    <div
      onClick={() => navigate(href)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        minHeight: 48,
        padding: '0 16px',
        borderBottom: `1px solid ${salon.line}`,
        cursor: 'pointer',
        color: salon.ink,
      }}
    >
      <div
        style={{
          flex: 1,
          minWidth: 220,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <CTIcon name="doc" size={13} stroke={salon.ink2} />
        <Link
          to={href}
          onClick={(event) => event.stopPropagation()}
          style={{
            fontFamily: salonFont.mono,
            fontSize: 13,
            color: salon.ink,
            textDecoration: 'none',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {doc.title || 'Untitled document'}
        </Link>
        {doc.tabCount > 1 ? (
          <span
            title={`${doc.tabCount} tabs`}
            style={{
              flexShrink: 0,
              fontFamily: salonFont.mono,
              fontSize: 10,
              padding: '2px 6px',
              borderRadius: 6,
              background: 'var(--salon-paper-2, #f4ecdb)',
              color: salon.ink2,
              border: `1px solid ${salon.line}`,
            }}
          >
            {doc.tabCount} tabs
          </span>
        ) : null}
        {doc.pendingEditCount > 0 ? (
          <span
            aria-label={`${doc.pendingEditCount} pending edit${
              doc.pendingEditCount === 1 ? '' : 's'
            }`}
            style={{
              flexShrink: 0,
              fontFamily: salonFont.mono,
              fontSize: 10,
              textTransform: 'uppercase',
              letterSpacing: '0.1em',
              padding: '2px 6px',
              borderRadius: 6,
              background: salon.accentStrong,
              color: '#ffffff',
            }}
          >
            {doc.pendingEditCount} pending
          </span>
        ) : null}
      </div>

      <span style={{ width: COLS.format, flexShrink: 0 }}>
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            minWidth: 36,
            padding: '2px 6px',
            borderRadius: 6,
            fontFamily: salonFont.mono,
            fontSize: 10,
            fontWeight: 500,
            background: badge.bg,
            color: badge.fg,
          }}
        >
          {badge.label}
        </span>
      </span>

      <span
        style={{
          width: COLS.folder,
          flexShrink: 0,
          fontSize: 12.5,
          color: salon.ink2,
          opacity: folder ? 1 : 0.6,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {folder ?? '— Inbox'}
      </span>

      <span style={{ width: COLS.talk, flexShrink: 0, minWidth: 0 }}>
        {doc.primaryTalkId ? (
          <Link
            to={`/app/talks/${encodeURIComponent(doc.primaryTalkId)}`}
            onClick={(event) => event.stopPropagation()}
            className="salon-btn"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              maxWidth: '100%',
              padding: '2px 10px',
              borderRadius: 9999,
              fontSize: 11.5,
              textDecoration: 'none',
              background: 'var(--salon-paper, #fbf7ef)',
              color: salon.ink,
              border: `1px solid ${salon.line}`,
            }}
          >
            <CTIcon name="chat" size={10} stroke={salon.ink2} />
            <span
              style={{
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {talkTitle}
            </span>
          </Link>
        ) : (
          <span style={{ fontSize: 12, color: salon.ink2, opacity: 0.6 }}>
            — unlinked
          </span>
        )}
      </span>

      <span
        style={{
          width: COLS.activity,
          flexShrink: 0,
          fontFamily: salonFont.mono,
          fontSize: 11.5,
          color: salon.ink2,
        }}
      >
        {relativeAge(activityIso(doc)) ?? '—'}
      </span>

      <span
        style={{
          width: COLS.words,
          flexShrink: 0,
          textAlign: 'right',
          fontFamily: salonFont.mono,
          fontSize: 12.5,
          color: salon.ink,
        }}
      >
        {doc.wordCount.toLocaleString()}
      </span>
    </div>
  );
}
