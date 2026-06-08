/**
 * Document viewer + edit-review console over the native
 * `/api/v1/documents/:id` detail route. Renders the document's native tabs and
 * blocks (never a markdown/html body facade) and a pending-edit review panel.
 *
 * Accept/reject is page-owned: each action calls the native accept/reject API
 * and replaces the page's document state with the returned `NativeDocument`, so
 * version bumps and pending-edit removal come straight from the server. A 409
 * `version_conflict` (the document changed under the reviewer) is handled by a
 * quiet refetch + a notice, leaving the conflicting edit pending. We do not send
 * `expectedContentVersion`: the server's per-edit base-version check is the CAS,
 * and a single value is ambiguous for accept-all (which spans tabs).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import { Button, salon, salonFont } from '../salon';
import {
  ApiError,
  acceptAllDocumentEdits,
  acceptDocumentEdit,
  acceptDocumentEditRun,
  getDocument,
  rejectAllDocumentEdits,
  rejectDocumentEdit,
  rejectDocumentEditRun,
  type NativeDocument,
  type NativeDocumentEdit,
} from '../lib/api';
import { DocumentBlocks } from '../components/documents/DocumentBlocks';
import { PendingEditList } from '../components/documents/PendingEditList';
import {
  documentSummaryMeta,
  formatDocDate,
  type PendingRunGroup,
} from '../components/documents/documentsFormat';

type Phase = 'loading' | 'ready' | 'error' | 'not-found';

function addTo(set: Set<string>, value: string): Set<string> {
  const next = new Set(set);
  next.add(value);
  return next;
}

function removeFrom(set: Set<string>, value: string): Set<string> {
  const next = new Set(set);
  next.delete(value);
  return next;
}

export function DocumentDetailPage(): JSX.Element {
  const params = useParams<{ documentId: string }>();
  const documentId = params.documentId ?? '';

  const [doc, setDoc] = useState<NativeDocument | null>(null);
  const [phase, setPhase] = useState<Phase>('loading');
  const [loadError, setLoadError] = useState<string>('');
  const [activeTabId, setActiveTabId] = useState<string | null>(null);

  const [actionError, setActionError] = useState<string | null>(null);
  const [conflictNotice, setConflictNotice] = useState<string | null>(null);
  const [busyEditIds, setBusyEditIds] = useState<Set<string>>(new Set());
  const [busyRunIds, setBusyRunIds] = useState<Set<string>>(new Set());
  const [allBusy, setAllBusy] = useState(false);

  const activeLoad = useRef<{ cancelled: boolean } | null>(null);

  // Apply a server document, keeping the active tab if it still exists.
  const applyDocument = useCallback((next: NativeDocument) => {
    setDoc(next);
    setActiveTabId((current) => {
      if (current && next.tabs.some((tab) => tab.id === current))
        return current;
      return next.tabs[0]?.id ?? null;
    });
  }, []);

  const load = useCallback(
    async ({ quiet = false }: { quiet?: boolean } = {}) => {
      if (!documentId) {
        setPhase('not-found');
        return;
      }
      if (activeLoad.current) activeLoad.current.cancelled = true;
      const signal = { cancelled: false };
      activeLoad.current = signal;
      if (!quiet) setPhase('loading');
      try {
        const next = await getDocument({ documentId });
        if (signal.cancelled) return;
        applyDocument(next);
        setPhase('ready');
      } catch (err) {
        if (signal.cancelled) return;
        if (err instanceof ApiError && err.status === 404) {
          setPhase('not-found');
          return;
        }
        if (quiet) {
          // A background refetch failed; keep the current view but flag it.
          setActionError('Couldn’t refresh this document. Try again.');
          return;
        }
        setLoadError(
          err instanceof Error
            ? err.message
            : 'This document is unavailable right now.',
        );
        setPhase('error');
      }
    },
    [applyDocument, documentId],
  );

  useEffect(() => {
    void load();
    return () => {
      if (activeLoad.current) activeLoad.current.cancelled = true;
    };
  }, [load]);

  // Resolve a mutation failure: a version conflict quietly refetches and
  // notifies; a 404 (edit/run already resolved elsewhere) syncs by refetch;
  // anything else surfaces a retryable action error.
  const handleMutationError = useCallback(
    async (err: unknown) => {
      if (err instanceof ApiError && err.status === 409) {
        setConflictNotice(
          'This document changed while you were reviewing. We refreshed it — please re-check the remaining edits.',
        );
        await load({ quiet: true });
        return;
      }
      if (err instanceof ApiError && err.status === 404) {
        await load({ quiet: true });
        return;
      }
      setActionError('Couldn’t apply that change. Try again.');
    },
    [load],
  );

  const handleAcceptEdit = useCallback(
    async (edit: NativeDocumentEdit) => {
      setActionError(null);
      setConflictNotice(null);
      setBusyEditIds((set) => addTo(set, edit.id));
      try {
        const { document } = await acceptDocumentEdit({
          documentId,
          editId: edit.id,
        });
        applyDocument(document);
      } catch (err) {
        await handleMutationError(err);
      } finally {
        setBusyEditIds((set) => removeFrom(set, edit.id));
      }
    },
    [applyDocument, documentId, handleMutationError],
  );

  const handleRejectEdit = useCallback(
    async (edit: NativeDocumentEdit) => {
      setActionError(null);
      setConflictNotice(null);
      setBusyEditIds((set) => addTo(set, edit.id));
      try {
        const { document } = await rejectDocumentEdit({
          documentId,
          editId: edit.id,
        });
        applyDocument(document);
      } catch (err) {
        await handleMutationError(err);
      } finally {
        setBusyEditIds((set) => removeFrom(set, edit.id));
      }
    },
    [applyDocument, documentId, handleMutationError],
  );

  const handleAcceptRun = useCallback(
    async (group: PendingRunGroup) => {
      if (group.runId == null) return;
      const runId = group.runId;
      setActionError(null);
      setConflictNotice(null);
      setBusyRunIds((set) => addTo(set, runId));
      try {
        const { document } = await acceptDocumentEditRun({ documentId, runId });
        applyDocument(document);
      } catch (err) {
        await handleMutationError(err);
      } finally {
        setBusyRunIds((set) => removeFrom(set, runId));
      }
    },
    [applyDocument, documentId, handleMutationError],
  );

  const handleRejectRun = useCallback(
    async (group: PendingRunGroup) => {
      if (group.runId == null) return;
      const runId = group.runId;
      setActionError(null);
      setConflictNotice(null);
      setBusyRunIds((set) => addTo(set, runId));
      try {
        const { document } = await rejectDocumentEditRun({ documentId, runId });
        applyDocument(document);
      } catch (err) {
        await handleMutationError(err);
      } finally {
        setBusyRunIds((set) => removeFrom(set, runId));
      }
    },
    [applyDocument, documentId, handleMutationError],
  );

  const handleAcceptAll = useCallback(async () => {
    setActionError(null);
    setConflictNotice(null);
    setAllBusy(true);
    try {
      const { document } = await acceptAllDocumentEdits({ documentId });
      applyDocument(document);
    } catch (err) {
      await handleMutationError(err);
    } finally {
      setAllBusy(false);
    }
  }, [applyDocument, documentId, handleMutationError]);

  const handleRejectAll = useCallback(async () => {
    setActionError(null);
    setConflictNotice(null);
    setAllBusy(true);
    try {
      const { document } = await rejectAllDocumentEdits({ documentId });
      applyDocument(document);
    } catch (err) {
      await handleMutationError(err);
    } finally {
      setAllBusy(false);
    }
  }, [applyDocument, documentId, handleMutationError]);

  const activeTab = useMemo(
    () =>
      doc?.tabs.find((tab) => tab.id === activeTabId) ?? doc?.tabs[0] ?? null,
    [activeTabId, doc],
  );
  const pendingByBlock = useMemo(() => {
    const set = new Set<string>();
    for (const edit of doc?.pendingEdits ?? []) {
      if (edit.blockId) set.add(edit.blockId);
    }
    return set;
  }, [doc]);

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
      <Link
        to="/app/documents"
        className="salon-btn"
        style={{
          alignSelf: 'flex-start',
          fontSize: 13,
          color: salon.ink2,
          textDecoration: 'none',
        }}
      >
        ← Documents
      </Link>

      {phase === 'loading' ? (
        <div aria-busy="true" aria-label="Loading document">
          <div
            className="ct-pulse"
            style={{
              height: 32,
              width: '60%',
              borderRadius: 10,
              marginBottom: 14,
              background: 'var(--salon-paper-2, #f4ecdb)',
            }}
          />
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="ct-pulse"
              style={{
                height: 18,
                marginBottom: 10,
                borderRadius: 8,
                background: 'var(--salon-paper-2, #f4ecdb)',
              }}
            />
          ))}
        </div>
      ) : null}

      {phase === 'not-found' ? (
        <DetailCard>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ fontSize: 14, fontWeight: 500, color: salon.ink }}>
              Document not found
            </div>
            <div style={{ fontSize: 13, color: salon.ink2 }}>
              This document may have been removed, or you don’t have access to
              it.
            </div>
            <div>
              <Link to="/app/documents" className="salon-btn">
                <Button variant="secondary">Back to documents</Button>
              </Link>
            </div>
          </div>
        </DetailCard>
      ) : null}

      {phase === 'error' ? (
        <DetailCard>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ fontSize: 13, color: salon.ink2 }}>{loadError}</div>
            <div>
              <Button variant="secondary" onClick={() => void load()}>
                Try again
              </Button>
            </div>
          </div>
        </DetailCard>
      ) : null}

      {phase === 'ready' && doc ? (
        <>
          <header style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <h1
              style={{
                margin: 0,
                fontFamily: salonFont.serif,
                fontSize: 26,
                fontWeight: 500,
                color: salon.ink,
              }}
            >
              {doc.title || 'Untitled document'}
            </h1>
            <p style={{ margin: 0, fontSize: 12.5, color: salon.ink2 }}>
              {documentSummaryMeta(doc)}
              {doc.lastEditAt
                ? ` · edited ${formatDocDate(doc.lastEditAt)}`
                : ''}
            </p>
          </header>

          {conflictNotice ? (
            <div
              role="status"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '10px 14px',
                borderRadius: 12,
                background: 'var(--salon-paper-2, #f4ecdb)',
                color: salon.ink,
                fontSize: 13,
              }}
            >
              <span style={{ flex: 1 }}>{conflictNotice}</span>
              <button
                type="button"
                onClick={() => setConflictNotice(null)}
                aria-label="Dismiss notice"
                className="salon-btn"
                style={{
                  border: 'none',
                  background: 'transparent',
                  color: salon.ink2,
                  cursor: 'pointer',
                  fontSize: 13,
                }}
              >
                Dismiss
              </button>
            </div>
          ) : null}

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

          {doc.tabs.length > 1 ? (
            <div
              role="tablist"
              aria-label="Document tabs"
              style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}
            >
              {doc.tabs.map((tab) => {
                const active = tab.id === activeTab?.id;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    onClick={() => setActiveTabId(tab.id)}
                    className="salon-btn"
                    style={{
                      height: 32,
                      padding: '0 14px',
                      borderRadius: 9999,
                      fontFamily: salonFont.sans,
                      fontSize: 13,
                      fontWeight: 500,
                      cursor: 'pointer',
                      color: active ? salon.ink : salon.ink2,
                      background: active ? salon.card : 'transparent',
                      border: `1px solid ${active ? salon.line : 'transparent'}`,
                    }}
                  >
                    {tab.title || 'Untitled tab'}
                  </button>
                );
              })}
            </div>
          ) : null}

          <article
            style={{
              background: salon.card,
              border: `1px solid ${salon.line}`,
              borderRadius: 16,
              padding: '20px 22px',
            }}
          >
            <DocumentBlocks
              blocks={activeTab?.blocks ?? []}
              pendingByBlock={pendingByBlock}
            />
          </article>

          {doc.pendingEdits.length > 0 ? (
            <PendingEditList
              doc={doc}
              busyEditIds={busyEditIds}
              busyRunIds={busyRunIds}
              allBusy={allBusy}
              onAcceptEdit={(edit) => void handleAcceptEdit(edit)}
              onRejectEdit={(edit) => void handleRejectEdit(edit)}
              onAcceptRun={(group) => void handleAcceptRun(group)}
              onRejectRun={(group) => void handleRejectRun(group)}
              onAcceptAll={() => void handleAcceptAll()}
              onRejectAll={() => void handleRejectAll()}
            />
          ) : (
            <div style={{ fontSize: 13, color: salon.ink2 }}>
              No pending edits. Agent proposals will appear here for review.
            </div>
          )}
        </>
      ) : null}
    </div>
  );
}

function DetailCard({ children }: { children: React.ReactNode }): JSX.Element {
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
