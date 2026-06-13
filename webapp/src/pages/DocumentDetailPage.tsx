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
import { useId, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import { Button, CTIcon, salon, salonFont, Textarea } from '../salon';
import { CopyExportMenu } from '../components/CopyExportMenu';
import { DocumentBlocks } from '../components/documents/DocumentBlocks';
import { PendingEditList } from '../components/documents/PendingEditList';
import { FormatPill } from '../components/FormatPill';
import { serializeDocumentBlocksForEditing } from '../components/documents/documentText';
import {
  documentSummaryMeta,
  formatDocDate,
} from '../components/documents/documentsFormat';
import { useNativeDocumentReview } from '../hooks/useNativeDocumentReview';
import { nativeDocumentToExportSource } from '../lib/doc-export';
import type { NativeDocumentEdit, NativeDocumentFormat } from '../lib/api';

export function DocumentDetailPage(): JSX.Element {
  const params = useParams<{ documentId: string }>();
  const documentId = params.documentId ?? '';

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
    savingTabIds,
    allBusy,
    reload,
    saveTabText,
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
  const [editingTabId, setEditingTabId] = useState<string | null>(null);
  const [draftText, setDraftText] = useState('');

  const tabIdFor = (tabId: string) => `${tabBaseId}-tab-${tabId}`;
  const tabPanelId = `${tabBaseId}-panel`;
  const activePendingEdits =
    doc?.pendingEdits.filter((edit) => edit.tabId === activeTab?.id) ?? [];
  const isEditingActiveTab =
    editingTabId !== null && editingTabId === activeTab?.id;
  const actionLocked =
    allBusy ||
    busyEditIds.size > 0 ||
    busyRunIds.size > 0 ||
    savingTabIds.size > 0;
  const activeTabSaving = activeTab ? savingTabIds.has(activeTab.id) : false;

  const cancelEditing = () => {
    setEditingTabId(null);
    setDraftText('');
  };

  const selectTab = (tabId: string) => {
    if (tabId !== activeTab?.id) cancelEditing();
    setActiveTabId(tabId);
  };

  const startEditing = () => {
    if (!activeTab || activePendingEdits.length > 0 || actionLocked) return;
    setEditingTabId(activeTab.id);
    setDraftText(serializeDocumentBlocksForEditing(activeTab.blocks));
  };

  const saveEditing = async () => {
    if (!activeTab || !isEditingActiveTab || activeTabSaving) return;
    const saved = await saveTabText({
      tabId: activeTab.id,
      text: draftText,
      expectedListVersion: activeTab.listVersion,
    });
    if (saved) cancelEditing();
  };

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
    selectTab(nextTab.id);
    tabButtonsRef.current.get(nextTab.id)?.focus();
  };

  return (
    <div
      className="ct-screen-enter ct-thin-scroll"
      style={{
        minHeight: 'calc(100vh - 68px)',
        margin: 0,
        padding: 0,
        display: 'flex',
        flexDirection: 'column',
        background: salon.paper,
      }}
    >
      <div
        style={{
          minHeight: 46,
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '0 28px',
          borderBottom: `1px solid ${salon.line}`,
          background: salon.paper2,
          color: salon.ink2,
          fontSize: 12,
        }}
      >
        <Link
          to="/app/documents"
          className="salon-btn"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
            color: salon.ink2,
            textDecoration: 'none',
          }}
        >
          <span style={{ transform: 'rotate(180deg)', display: 'inline-flex' }}>
            <CTIcon name="chevron-r" size={12} />
          </span>
          Documents
        </Link>
        {doc ? (
          <>
            <span aria-hidden="true">·</span>
            <CTIcon name="doc" size={13} stroke={salon.ink2} />
            <span
              style={{
                minWidth: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                color: salon.ink,
                fontFamily: salonFont.mono,
              }}
            >
              {doc.title || 'Untitled document'}
            </span>
            <DocumentFormatPills format={doc.format} />
            <div style={{ flex: 1 }} />
            <CopyExportMenu
              source={nativeDocumentToExportSource(doc)}
              documentTitle={doc.title || 'Untitled document'}
            />
          </>
        ) : null}
      </div>

      {phase === 'loading' ? (
        <div
          aria-busy="true"
          aria-label="Loading document"
          style={{
            width: '100%',
            maxWidth: 720,
            margin: '0 auto',
            padding: '32px',
          }}
        >
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
              width: '100%',
              maxWidth: 720,
              margin: '0 auto',
              padding: '28px 32px 0',
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
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'flex-end',
                gap: 8,
                flexWrap: 'wrap',
              }}
            >
              <DocumentFormatPills format={doc.format} />
              {isEditingActiveTab ? (
                <>
                  <Button
                    variant="primary"
                    disabled={activeTabSaving}
                    onClick={() => void saveEditing()}
                    aria-label="Save document"
                  >
                    <CTIcon name="check" size={14} />
                    {activeTabSaving ? 'Saving' : 'Save'}
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={activeTabSaving}
                    onClick={cancelEditing}
                    aria-label="Cancel editing"
                  >
                    <CTIcon name="x" size={14} />
                    Cancel
                  </Button>
                </>
              ) : (
                <Button
                  variant="secondary"
                  disabled={
                    !activeTab || actionLocked || activePendingEdits.length > 0
                  }
                  onClick={startEditing}
                  aria-label="Edit document"
                >
                  <CTIcon name="edit" size={14} />
                  Edit
                </Button>
              )}
            </div>
          </header>

          {conflictNotice ? (
            <div
              role="status"
              style={{
                width: 'calc(100% - 64px)',
                maxWidth: 720,
                margin: '0 auto',
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
                width: 'calc(100% - 64px)',
                maxWidth: 720,
                margin: '0 auto',
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
              style={{
                width: '100%',
                maxWidth: 720,
                margin: '0 auto',
                padding: '8px 32px 0',
                display: 'flex',
                gap: 6,
                flexWrap: 'wrap',
              }}
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
                    onClick={() => selectTab(tab.id)}
                    onKeyDown={(event) => handleTabKeyDown(event, index)}
                    className="salon-btn"
                    style={{
                      height: 32,
                      padding: '0 14px',
                      borderRadius: 6,
                      fontFamily: salonFont.sans,
                      fontSize: 13,
                      fontWeight: 500,
                      cursor: 'pointer',
                      color: active ? salon.accentStrong : salon.ink2,
                      background: active ? salon.card : 'transparent',
                      border: `1px solid ${active ? salon.line : 'transparent'}`,
                      boxShadow: active
                        ? '0 1px 2px rgba(31,27,22,0.04)'
                        : 'none',
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
              width: '100%',
              maxWidth: 720,
              margin: '0 auto',
              padding: '24px 32px 112px',
              background: 'transparent',
              border: 'none',
              outline: 'none',
            }}
          >
            {isEditingActiveTab ? (
              <Textarea
                aria-label={`Edit ${activeTab?.title || 'document tab'}`}
                value={draftText}
                onChange={(event) => setDraftText(event.target.value)}
                disabled={activeTabSaving}
                style={{
                  minHeight: 520,
                  resize: 'vertical',
                  borderRadius: 12,
                  fontFamily: salonFont.serif,
                  fontSize: 17,
                  lineHeight: 1.6,
                  background: salon.card,
                }}
              />
            ) : (
              <DocumentBlocks
                blocks={activeTab?.blocks ?? []}
                pendingEdits={activePendingEdits}
                format={doc.format}
              />
            )}
          </article>

          {doc.pendingEdits.length > 0 ? (
            <>
              <div
                style={{
                  width: 'calc(100% - 64px)',
                  maxWidth: 720,
                  margin: '-84px auto 24px',
                }}
              >
                <PendingEditList
                  doc={doc}
                  busyEditIds={busyEditIds}
                  busyRunIds={busyRunIds}
                  allBusy={allBusy || savingTabIds.size > 0}
                  onAcceptEdit={(edit) => void acceptEdit(edit)}
                  onRejectEdit={(edit) => void rejectEdit(edit)}
                  onAcceptRun={(group) => void acceptRun(group)}
                  onRejectRun={(group) => void rejectRun(group)}
                  onAcceptAll={() => void acceptAll()}
                  onRejectAll={() => void rejectAll()}
                />
              </div>
              {/* Design's floating review bar: the bulk controls ride the
                  viewport bottom so a long edit list never hides them. */}
              <div
                role="region"
                aria-label="Pending edit actions"
                style={{
                  position: 'sticky',
                  bottom: 12,
                  zIndex: 5,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '10px 14px',
                  background: salon.paper2,
                  borderTop: `1px solid ${salon.line}`,
                  boxShadow: '0 -8px 24px rgba(31, 27, 22, 0.06)',
                }}
              >
                <CTIcon name="sparkle" size={14} stroke={salon.accent} />
                <span
                  style={{
                    flex: 1,
                    fontSize: 12.5,
                    color: salon.ink,
                  }}
                >
                  <strong>
                    {doc.pendingEdits.length} pending edit
                    {doc.pendingEdits.length === 1 ? '' : 's'}
                  </strong>{' '}
                  from <em>{pendingEditorSummary(doc.pendingEdits)}</em>.
                </span>
                <Button
                  variant="secondary"
                  disabled={
                    actionLocked || busyEditIds.size > 0 || busyRunIds.size > 0
                  }
                  onClick={() => void rejectAll()}
                >
                  Reject all
                </Button>
                <Button
                  variant="primary"
                  disabled={
                    actionLocked || busyEditIds.size > 0 || busyRunIds.size > 0
                  }
                  onClick={() => void acceptAll()}
                  aria-label="Accept all"
                >
                  {allBusy ? 'Working…' : 'Accept & continue'}
                </Button>
              </div>
            </>
          ) : (
            <div
              style={{
                width: '100%',
                maxWidth: 720,
                margin: '-84px auto 24px',
                padding: '0 32px',
                fontSize: 13,
                color: salon.ink2,
              }}
            >
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
        width: 'calc(100% - 64px)',
        maxWidth: 720,
        margin: '32px auto',
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

function pendingEditorSummary(edits: NativeDocumentEdit[]): string {
  const names = Array.from(
    new Set(
      edits.map(
        (edit) =>
          edit.proposedByAgentName ??
          (edit.source === 'forge'
            ? 'Forge'
            : edit.source === 'job'
              ? 'Job'
              : 'Agent'),
      ),
    ),
  );
  if (names.length === 0) return 'Agent';
  if (names.length === 1) return names[0]!;
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names[0]} and ${names.length - 1} others`;
}
