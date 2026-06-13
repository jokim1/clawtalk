/**
 * Pending-edit review panel for a native document.
 *
 * Renders agent-proposed `document_edits` grouped by the run that produced them,
 * with per-edit, per-run, and whole-document accept/reject controls. All actions
 * are page-owned (the page calls the native accept/reject API and replaces its
 * document state with the returned `NativeDocument`); this component is
 * presentational and only reports intent + reflects busy state.
 */
import { Button, Chip, salon, salonFont } from '../../salon';
import type { NativeDocument, NativeDocumentEdit } from '../../lib/api';
import {
  EDIT_SOURCE_LABEL,
  groupPendingEditsByRun,
  insertAnchorLabel,
  previewEdit,
  tabTitleForEdit,
  type PendingRunGroup,
} from './documentsFormat';
import { parseDocumentDisplayBlocks } from './documentText';

type Props = {
  doc: NativeDocument;
  /** Edit ids with an accept/reject in flight. */
  busyEditIds: Set<string>;
  /** Run ids with a run-level accept/reject in flight. */
  busyRunIds: Set<string>;
  /** True while an accept-all / reject-all spans the whole document. */
  allBusy: boolean;
  onAcceptEdit: (edit: NativeDocumentEdit) => void;
  onRejectEdit: (edit: NativeDocumentEdit) => void;
  onAcceptRun: (group: PendingRunGroup) => void;
  onRejectRun: (group: PendingRunGroup) => void;
  onAcceptAll: () => void;
  onRejectAll: () => void;
};

function PreviewText({
  label,
  text,
  tone,
  format,
}: {
  label: string;
  text: string;
  tone: 'before' | 'after';
  format: NativeDocument['format'];
}): JSX.Element {
  const blocks = parseDocumentDisplayBlocks({ text, format });
  const visibleBlocks =
    blocks.length > 0 ? blocks : [{ kind: 'p' as const, text }];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <span
        style={{
          fontSize: 11,
          fontWeight: 600,
          letterSpacing: 0.3,
          textTransform: 'uppercase',
          color: salon.ink2,
        }}
      >
        {label}
      </span>
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
          fontSize: 13,
          lineHeight: 1.5,
          color: tone === 'before' ? salon.ink2 : salon.ink,
          textDecoration: tone === 'before' ? 'line-through' : 'none',
          overflowWrap: 'anywhere',
        }}
      >
        {visibleBlocks.length > 0
          ? visibleBlocks.map((block, index) => (
              <span
                key={`${label}-${index}`}
                style={{
                  fontFamily:
                    block.kind === 'h1' || block.kind === 'h2'
                      ? salonFont.serif
                      : block.kind === 'code'
                        ? salonFont.mono
                        : undefined,
                  fontWeight:
                    block.kind === 'h1' || block.kind === 'h2' ? 600 : 400,
                }}
              >
                {block.kind === 'li' ? `• ${block.text}` : block.text}
              </span>
            ))
          : '—'}
      </div>
    </div>
  );
}

function EditCard({
  doc,
  edit,
  busy,
  disabled,
  onAccept,
  onReject,
}: {
  doc: NativeDocument;
  edit: NativeDocumentEdit;
  busy: boolean;
  disabled: boolean;
  onAccept: () => void;
  onReject: () => void;
}): JSX.Element {
  const preview = previewEdit(doc, edit);
  const anchor = insertAnchorLabel(doc, edit);
  return (
    <li
      style={{
        listStyle: 'none',
        border: `1px solid ${salon.line}`,
        borderRadius: 12,
        padding: 14,
        background: salon.card,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          gap: 10,
          flexWrap: 'wrap',
        }}
      >
        <span style={{ fontSize: 14, fontWeight: 600, color: salon.ink }}>
          {preview.title}
        </span>
        <span style={{ fontSize: 12, color: salon.ink2 }}>
          {tabTitleForEdit(doc, edit)}
        </span>
      </div>
      {anchor ? (
        <span style={{ fontSize: 12, color: salon.ink2 }}>{anchor}</span>
      ) : null}
      {preview.beforeText != null ? (
        <PreviewText
          label="Current"
          text={preview.beforeText}
          tone="before"
          format={doc.format}
        />
      ) : null}
      {preview.afterText != null ? (
        <PreviewText
          label="Proposed"
          text={preview.afterText}
          tone="after"
          format={doc.format}
        />
      ) : null}
      <div style={{ display: 'flex', gap: 8 }}>
        <Button
          variant="primary"
          disabled={disabled || busy}
          onClick={onAccept}
          aria-label={`Accept ${preview.title.toLowerCase()}`}
        >
          {busy ? 'Working…' : 'Accept'}
        </Button>
        <Button
          variant="secondary"
          disabled={disabled || busy}
          onClick={onReject}
          aria-label={`Reject ${preview.title.toLowerCase()}`}
        >
          Reject
        </Button>
      </div>
    </li>
  );
}

export function PendingEditList({
  doc,
  busyEditIds,
  busyRunIds,
  allBusy,
  onAcceptEdit,
  onRejectEdit,
  onAcceptRun,
  onRejectRun,
  onAcceptAll,
  onRejectAll,
}: Props): JSX.Element {
  const groups = groupPendingEditsByRun(doc.pendingEdits);
  const total = doc.pendingEdits.length;
  // Serialize every accept/reject across the panel: each action resolves to a
  // full server document snapshot, so allowing two in flight at once risks a
  // late, stale snapshot resurrecting an edit a newer action already removed.
  // One at a time keeps the view consistent (each button still shows its own
  // "Working…" label via its busy flag).
  const anyBusy = allBusy || busyEditIds.size > 0 || busyRunIds.size > 0;

  return (
    <section
      aria-label="Pending edits"
      style={{ display: 'flex', flexDirection: 'column', gap: 14 }}
    >
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 10,
          flexWrap: 'wrap',
        }}
      >
        <h2
          style={{
            margin: 0,
            fontFamily: salonFont.serif,
            fontSize: 18,
            fontWeight: 500,
            color: salon.ink,
          }}
        >
          Pending edits{' '}
          <span style={{ color: salon.ink2, fontFamily: salonFont.sans }}>
            ({total})
          </span>
        </h2>
        <div style={{ display: 'flex', gap: 8 }}>
          <Button variant="primary" disabled={anyBusy} onClick={onAcceptAll}>
            {allBusy ? 'Working…' : 'Accept all'}
          </Button>
          <Button variant="secondary" disabled={anyBusy} onClick={onRejectAll}>
            Reject all
          </Button>
        </div>
      </header>

      {groups.map((group) => {
        const runBusy = group.runId != null && busyRunIds.has(group.runId);
        const groupDisabled = anyBusy;
        return (
          <div
            key={group.runId ?? group.edits[0]?.id}
            style={{ display: 'flex', flexDirection: 'column', gap: 10 }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                flexWrap: 'wrap',
              }}
            >
              <span style={{ fontSize: 13, fontWeight: 600, color: salon.ink }}>
                {group.agentName}
              </span>
              <Chip>{EDIT_SOURCE_LABEL[group.source]}</Chip>
              <span style={{ fontSize: 12, color: salon.ink2 }}>
                {group.edits.length} change
                {group.edits.length === 1 ? '' : 's'}
              </span>
              {group.runId != null && group.edits.length > 1 ? (
                <div style={{ display: 'flex', gap: 6, marginLeft: 'auto' }}>
                  <Button
                    variant="ghost"
                    disabled={groupDisabled}
                    onClick={() => onAcceptRun(group)}
                  >
                    {runBusy ? 'Working…' : 'Accept run'}
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={groupDisabled}
                    onClick={() => onRejectRun(group)}
                  >
                    Reject run
                  </Button>
                </div>
              ) : null}
            </div>
            <ul
              style={{
                margin: 0,
                padding: 0,
                display: 'flex',
                flexDirection: 'column',
                gap: 10,
              }}
            >
              {group.edits.map((edit) => (
                <EditCard
                  key={edit.id}
                  doc={doc}
                  edit={edit}
                  busy={busyEditIds.has(edit.id)}
                  disabled={groupDisabled}
                  onAccept={() => onAcceptEdit(edit)}
                  onReject={() => onRejectEdit(edit)}
                />
              ))}
            </ul>
          </div>
        );
      })}
    </section>
  );
}
