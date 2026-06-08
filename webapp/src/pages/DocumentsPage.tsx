/**
 * Documents — workspace document index over the native `/api/v1/documents`
 * list route. Lists every document (linked + unlinked) with its tab/block/word
 * counts and pending-edit count; each row opens the native document viewer.
 * Read-only: documents are produced by agent runs, jobs, and Forge, so there is
 * no create affordance here — the surface is for reviewing and resolving them.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

import { Button, salon, salonFont } from '../salon';
import { listDocuments, type NativeDocumentSummary } from '../lib/api';
import {
  documentSummaryMeta,
  formatDocDate,
} from '../components/documents/documentsFormat';

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; documents: NativeDocumentSummary[] };

export function DocumentsPage(): JSX.Element {
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const activeLoad = useRef<{ cancelled: boolean } | null>(null);

  const load = useCallback(async () => {
    if (activeLoad.current) activeLoad.current.cancelled = true;
    const signal = { cancelled: false };
    activeLoad.current = signal;
    setState({ status: 'loading' });
    try {
      const documents = await listDocuments();
      if (signal.cancelled) return;
      setState({ status: 'ready', documents });
    } catch (err) {
      if (signal.cancelled) return;
      const message =
        err instanceof Error
          ? err.message
          : 'Documents are unavailable right now.';
      setState({ status: 'error', message });
    }
  }, []);

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
          Documents
        </h1>
        <p style={{ margin: '4px 0 0', fontSize: 13, color: salon.ink2 }}>
          Documents your agents draft and revise. Open one to read it and review
          pending edits.
        </p>
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
        <DocumentsCard>
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
        </DocumentsCard>
      ) : null}

      {state.status === 'ready' ? (
        state.documents.length === 0 ? (
          <DocumentsCard>
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
          </DocumentsCard>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {state.documents.map((doc) => (
              <DocumentRow key={doc.id} doc={doc} />
            ))}
          </div>
        )
      ) : null}
    </div>
  );
}

function DocumentsCard({
  children,
}: {
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div
      style={{
        background: salon.card,
        border: `1px solid ${salon.line}`,
        borderRadius: 16,
        padding: 16,
      }}
    >
      {children}
    </div>
  );
}

function DocumentRow({ doc }: { doc: NativeDocumentSummary }): JSX.Element {
  const lastEdit = formatDocDate(doc.lastEditAt);
  return (
    <Link
      to={`/app/documents/${encodeURIComponent(doc.id)}`}
      className="salon-btn"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        background: salon.card,
        border: `1px solid ${salon.line}`,
        borderRadius: 12,
        padding: '12px 14px',
        textDecoration: 'none',
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 14,
            fontWeight: 500,
            color: salon.ink,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {doc.title || 'Untitled document'}
        </div>
        <div style={{ fontSize: 12, color: salon.ink2, marginTop: 2 }}>
          {documentSummaryMeta(doc)}
          {lastEdit ? ` · edited ${lastEdit}` : ''}
        </div>
      </div>
      {doc.pendingEditCount > 0 ? (
        <span
          aria-label={`${doc.pendingEditCount} pending edit${
            doc.pendingEditCount === 1 ? '' : 's'
          }`}
          style={{
            flexShrink: 0,
            fontSize: 12,
            fontWeight: 600,
            color: salon.accentStrong,
            background: 'var(--salon-paper-2, #f4ecdb)',
            border: `1px solid ${salon.line}`,
            borderRadius: 9999,
            padding: '3px 10px',
          }}
        >
          {doc.pendingEditCount} pending
        </span>
      ) : null}
    </Link>
  );
}
