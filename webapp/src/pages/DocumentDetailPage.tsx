/**
 * Document viewer + edit-review console over the native
 * `/api/v1/documents/:id` detail route. Renders the document's native tabs and
 * blocks (never a markdown/html body facade) and a pending-edit review panel.
 *
 * All load + accept/reject state lives in `useNativeDocumentReview`; this page is
 * the standalone presentation of it (the in-Talk documents pane is the other
 * consumer). The page is remounted per `documentId` (see App.tsx) so the hook
 * only ever handles one document.
 */
import { useId, useRef } from 'react';
import { Link, useParams } from 'react-router-dom';

import { Button, salon, salonFont } from '../salon';
import { CopyExportMenu } from '../components/CopyExportMenu';
import { DocumentBlocks } from '../components/documents/DocumentBlocks';
import { PendingEditList } from '../components/documents/PendingEditList';
import {
  documentSummaryMeta,
  formatDocDate,
} from '../components/documents/documentsFormat';
import { useNativeDocumentReview } from '../hooks/useNativeDocumentReview';
import { nativeDocumentToExportSource } from '../lib/doc-export';

export function DocumentDetailPage(): JSX.Element {
  const params = useParams<{ documentId: string }>();
  const documentId = params.documentId ?? '';

  const {
    doc,
    phase,
    loadError,
    setActiveTabId,
    activeTab,
    pendingByBlock,
    actionError,
    conflictNotice,
    setActionError,
    setConflictNotice,
    busyEditIds,
    busyRunIds,
    allBusy,
    reload,
    acceptEdit,
    rejectEdit,
    acceptRun,
    rejectRun,
    acceptAll,
    rejectAll,
  } = useNativeDocumentReview(documentId);

  // Tab roving-focus refs for the WAI-ARIA tablist keyboard pattern.
  const tabBaseId = useId();
  const tabButtonsRef = useRef<Map<string, HTMLButtonElement>>(new Map());

  const tabIdFor = (tabId: string) => `${tabBaseId}-tab-${tabId}`;
  const tabPanelId = `${tabBaseId}-panel`;

  // WAI-ARIA tablist keyboard nav: arrows move (wrapping), Home/End jump, and
  // focus follows selection so the roving tabindex stays on the active tab.
  const handleTabKeyDown = (
    event: React.KeyboardEvent<HTMLButtonElement>,
    index: number,
  ) => {
    const tabs = doc?.tabs ?? [];
    if (tabs.length < 2) return;
    let nextIndex: number | null = null;
    if (event.key === 'ArrowRight') nextIndex = (index + 1) % tabs.length;
    else if (event.key === 'ArrowLeft')
      nextIndex = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = tabs.length - 1;
    if (nextIndex === null) return;
    const nextTab = tabs[nextIndex];
    if (!nextTab) return;
    event.preventDefault();
    setActiveTabId(nextTab.id);
    tabButtonsRef.current.get(nextTab.id)?.focus();
  };

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
              <Link
                to="/app/documents"
                className="salon-btn"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  height: 36,
                  padding: '0 16px',
                  borderRadius: 9999,
                  fontFamily: salonFont.sans,
                  fontSize: 13,
                  fontWeight: 500,
                  color: salon.ink,
                  background: salon.card,
                  border: `1px solid ${salon.line}`,
                  textDecoration: 'none',
                }}
              >
                Back to documents
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
              <Button variant="secondary" onClick={() => void reload()}>
                Try again
              </Button>
            </div>
          </div>
        </DetailCard>
      ) : null}

      {phase === 'ready' && doc ? (
        <>
          <header
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'flex-start',
              gap: 12,
            }}
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
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
            </div>
            <CopyExportMenu
              source={nativeDocumentToExportSource(doc)}
              documentTitle={doc.title || 'Untitled document'}
            />
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
              {doc.tabs.map((tab, index) => {
                const active = tab.id === activeTab?.id;
                return (
                  <button
                    key={tab.id}
                    ref={(el) => {
                      if (el) tabButtonsRef.current.set(tab.id, el);
                      else tabButtonsRef.current.delete(tab.id);
                    }}
                    type="button"
                    role="tab"
                    id={tabIdFor(tab.id)}
                    aria-selected={active}
                    aria-controls={tabPanelId}
                    tabIndex={active ? 0 : -1}
                    onClick={() => setActiveTabId(tab.id)}
                    onKeyDown={(event) => handleTabKeyDown(event, index)}
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
            role={doc.tabs.length > 1 ? 'tabpanel' : undefined}
            id={doc.tabs.length > 1 ? tabPanelId : undefined}
            aria-labelledby={
              doc.tabs.length > 1 && activeTab
                ? tabIdFor(activeTab.id)
                : undefined
            }
            tabIndex={doc.tabs.length > 1 ? 0 : undefined}
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
              onAcceptEdit={(edit) => void acceptEdit(edit)}
              onRejectEdit={(edit) => void rejectEdit(edit)}
              onAcceptRun={(group) => void acceptRun(group)}
              onRejectRun={(group) => void rejectRun(group)}
              onAcceptAll={() => void acceptAll()}
              onRejectAll={() => void rejectAll()}
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
