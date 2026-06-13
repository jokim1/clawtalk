/**
 * Single native document rendered inside the Talk Documents tab.
 *
 * Reuses the shared `useNativeDocumentReview` hook (load + accept/reject) and the
 * presentational `DocumentBlocks` / `PendingEditList`. Reads only the native
 * tabs/blocks/edits — never a markdown/html body facade. The parent keys this by
 * documentId, so the hook only ever handles one document.
 *
 * Edit-review controls are gated on `canEditDoc`: reviewers get the full
 * accept/reject console; read-only members still see the document and a pending
 * count, with per-block pending markers from `DocumentBlocks`.
 */
import { useEffect, useId, useRef } from 'react';

import { Button, salon, salonFont } from '../../salon';
import { CopyExportMenu } from '../CopyExportMenu';
import { DocumentBlocks } from '../documents/DocumentBlocks';
import { PendingEditList } from '../documents/PendingEditList';
import { FormatPill } from '../FormatPill';
import {
  documentSummaryMeta,
  formatDocDate,
} from '../documents/documentsFormat';
import { useNativeDocumentReview } from '../../hooks/useNativeDocumentReview';
import { nativeDocumentToExportSource } from '../../lib/doc-export';
import type { NativeDocumentFormat } from '../../lib/api';

export interface TalkDocumentViewProps {
  documentId: string;
  workspaceId: string | null;
  canEditDoc: boolean;
  onUnauthorized: () => void;
  /**
   * Monotonic counter bumped by the live Talk run stream whenever an agent
   * edit run starts/applies/resolves against this Talk's document. Each bump
   * triggers a quiet native reload so the blocks + pending-edit list stay live
   * without the legacy flat-content snapshot refetch. Omitted by
   * non-streaming callers (e.g. the standalone Documents tab).
   */
  reloadSignal?: number;
}

export function TalkDocumentView({
  documentId,
  workspaceId,
  canEditDoc,
  onUnauthorized,
  reloadSignal = 0,
}: TalkDocumentViewProps): JSX.Element {
  const {
    doc,
    phase,
    loadError,
    setActiveTabId,
    activeTab,
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
  } = useNativeDocumentReview(documentId, { workspaceId, onUnauthorized });

  // Live agent-edit bridge: when the Talk run stream signals a content-edit
  // event for this document, reload quietly so new pending edits / applied
  // blocks surface without a full loading flash. Skips the initial render
  // (reloadSignal starts at 0); the hook's own mount load covers that.
  const lastReloadSignalRef = useRef(reloadSignal);
  useEffect(() => {
    if (reloadSignal === lastReloadSignalRef.current) return;
    lastReloadSignalRef.current = reloadSignal;
    void reload({ quiet: true });
  }, [reloadSignal, reload]);

  // Tab roving-focus refs for the WAI-ARIA tablist keyboard pattern.
  const tabBaseId = useId();
  const tabButtonsRef = useRef<Map<string, HTMLButtonElement>>(new Map());
  const tabIdFor = (tabId: string) => `${tabBaseId}-tab-${tabId}`;
  const tabPanelId = `${tabBaseId}-panel`;

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

  if (phase === 'loading') {
    return (
      <div aria-busy="true" aria-label="Loading document">
        <div
          className="ct-pulse"
          style={{
            height: 26,
            width: '55%',
            borderRadius: 8,
            marginBottom: 12,
            background: 'var(--salon-paper-2, #f4ecdb)',
          }}
        />
        {Array.from({ length: 4 }).map((_, i) => (
          <div
            key={i}
            className="ct-pulse"
            style={{
              height: 16,
              marginBottom: 9,
              borderRadius: 7,
              background: 'var(--salon-paper-2, #f4ecdb)',
            }}
          />
        ))}
      </div>
    );
  }

  if (phase === 'not-found') {
    return (
      <ViewCard>
        <div style={{ fontSize: 13.5, color: salon.ink2 }}>
          This document is no longer available — it may have been removed.
        </div>
      </ViewCard>
    );
  }

  if (phase === 'error') {
    return (
      <ViewCard>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ fontSize: 13, color: salon.ink2 }}>{loadError}</div>
          <div>
            <Button variant="secondary" onClick={() => void reload()}>
              Try again
            </Button>
          </div>
        </div>
      </ViewCard>
    );
  }

  if (!doc) return <></>;

  const pendingCount = doc.pendingEdits.length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <header
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          gap: 12,
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <h2
            style={{
              margin: 0,
              fontFamily: salonFont.serif,
              fontSize: 22,
              fontWeight: 500,
              color: salon.ink,
            }}
          >
            {doc.title || 'Untitled document'}
          </h2>
          <p style={{ margin: 0, fontSize: 12.5, color: salon.ink2 }}>
            {documentSummaryMeta(doc)}
            {doc.lastEditAt ? ` · edited ${formatDocDate(doc.lastEditAt)}` : ''}
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <DocumentFormatPills format={doc.format} />
          <CopyExportMenu
            source={nativeDocumentToExportSource(doc)}
            documentTitle={doc.title || 'Untitled document'}
          />
        </div>
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
                  height: 30,
                  padding: '0 13px',
                  borderRadius: 9999,
                  fontFamily: salonFont.sans,
                  fontSize: 12.5,
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
          doc.tabs.length > 1 && activeTab ? tabIdFor(activeTab.id) : undefined
        }
        tabIndex={doc.tabs.length > 1 ? 0 : undefined}
        style={{
          background: salon.card,
          border: `1px solid ${salon.line}`,
          borderRadius: 16,
          padding: '18px 20px',
        }}
      >
        <DocumentBlocks
          blocks={activeTab?.blocks ?? []}
          pendingEdits={doc.pendingEdits.filter(
            (edit) => edit.tabId === activeTab?.id,
          )}
          format={doc.format}
        />
      </article>

      {pendingCount > 0 ? (
        canEditDoc ? (
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
          <div role="status" style={{ fontSize: 13, color: salon.ink2 }}>
            {pendingCount} pending edit{pendingCount === 1 ? '' : 's'} awaiting
            review. You don’t have permission to review edits in this Talk.
          </div>
        )
      ) : (
        <div style={{ fontSize: 13, color: salon.ink2 }}>
          No pending edits. Agent proposals will appear here for review.
        </div>
      )}
    </div>
  );
}

function DocumentFormatPills({
  format,
}: {
  format: NativeDocumentFormat;
}): JSX.Element {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
      {format === 'markdown' ? (
        <FormatPill format="markdown" />
      ) : (
        <span className="format-pill format-pill-inactive">MD</span>
      )}
      {format === 'html' ? (
        <FormatPill format="html" />
      ) : (
        <span className="format-pill format-pill-inactive">HTML</span>
      )}
    </span>
  );
}

function ViewCard({ children }: { children: React.ReactNode }): JSX.Element {
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
