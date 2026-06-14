/**
 * Presentational renderer for a native document tab's blocks.
 *
 * Native storage is still block-kind + text. This view expands Markdown/HTML-ish
 * text into readable blocks and renders pending edits as inline review regions
 * at their document location.
 */
import { Button, salon, salonFont } from '../../salon';
import type {
  NativeDocumentBlock,
  NativeDocumentEdit,
  NativeDocumentFormat,
} from '../../lib/api';
import { parseDocumentDisplayBlocks } from './documentText';

type DisplayBlock = {
  key: string;
  kind: NativeDocumentBlock['kind'];
  text: string;
};

type SuggestionMode = 'replace' | 'insert' | 'delete';

type RenderItem =
  | {
      type: 'block';
      key: string;
      block: DisplayBlock;
    }
  | {
      type: 'suggestion';
      key: string;
      edit: NativeDocumentEdit;
      mode: SuggestionMode;
      label: string;
      anchorMissing?: boolean;
      currentBlocks: DisplayBlock[];
      proposedBlocks: DisplayBlock[];
    };

type SuggestionTone = {
  accent: string;
  badgeBackground: string;
  containerBackground: string;
  currentBackground: string;
  proposedBackground: string;
};

const DELETE_TONE: SuggestionTone = {
  accent: '#7b2a30',
  badgeBackground: '#7b2a30',
  containerBackground: 'rgba(123,42,48,0.07)',
  currentBackground: 'rgba(123,42,48,0.045)',
  proposedBackground: 'rgba(255,255,255,0.42)',
};

const PROPOSE_TONE: SuggestionTone = {
  accent: salon.accent,
  badgeBackground: salon.accentStrong,
  containerBackground: 'rgba(200,100,58,0.08)',
  currentBackground: 'rgba(123,42,48,0.045)',
  proposedBackground: 'rgba(255,255,255,0.42)',
};

const BASE_TEXT_STYLE: React.CSSProperties = {
  color: salon.ink,
  overflowWrap: 'anywhere',
};

function pendingLabel(edit: NativeDocumentEdit): string {
  const actor =
    edit.proposedByAgentName ??
    (edit.source === 'agent'
      ? 'Agent'
      : edit.source === 'forge'
        ? 'Forge'
        : 'Job');
  return `${edit.op === 'delete' ? 'Delete suggested' : 'Suggested'} by ${actor}`;
}

function expandedBlocks(input: {
  keyBase: string;
  kind: NativeDocumentBlock['kind'];
  text: string;
  format: NativeDocumentFormat;
}): DisplayBlock[] {
  const parsed = parseDocumentDisplayBlocks({
    text: input.text,
    fallbackKind: input.kind,
    format: input.format,
  });
  const blocks =
    parsed.length > 0 ? parsed : [{ kind: input.kind, text: input.text }];
  return blocks.map((block, index) => ({
    key: `${input.keyBase}:${index}`,
    kind: block.kind,
    text: block.text,
  }));
}

function buildRenderItems(input: {
  blocks: NativeDocumentBlock[];
  pendingEdits: NativeDocumentEdit[];
  format: NativeDocumentFormat;
}): RenderItem[] {
  const pendingByBlock = new Map<string, NativeDocumentEdit[]>();
  const insertsByAnchor = new Map<string, NativeDocumentEdit[]>();
  const topInserts: NativeDocumentEdit[] = [];

  for (const edit of input.pendingEdits) {
    if (edit.op === 'insert') {
      if (edit.afterBlockId) {
        const edits = insertsByAnchor.get(edit.afterBlockId) ?? [];
        edits.push(edit);
        insertsByAnchor.set(edit.afterBlockId, edits);
      } else {
        topInserts.push(edit);
      }
      continue;
    }
    if (edit.blockId) {
      const edits = pendingByBlock.get(edit.blockId) ?? [];
      edits.push(edit);
      pendingByBlock.set(edit.blockId, edits);
    }
  }

  const renderBlock = (block: NativeDocumentBlock): RenderItem[] =>
    expandedBlocks({
      keyBase: `block:${block.id}`,
      kind: block.kind,
      text: block.text,
      format: input.format,
    }).map((entry) => ({
      type: 'block',
      key: entry.key,
      block: entry,
    }));

  const renderInsert = (
    edit: NativeDocumentEdit,
    options: { anchorMissing?: boolean } = {},
  ): RenderItem[] => {
    if (edit.newText === null) return [];
    return [
      {
        type: 'suggestion',
        key: `edit:${edit.id}`,
        edit,
        mode: 'insert',
        label: pendingLabel(edit),
        anchorMissing: options.anchorMissing,
        currentBlocks: [],
        proposedBlocks: expandedBlocks({
          keyBase: `edit:${edit.id}:proposed`,
          kind: edit.newKind ?? 'p',
          text: edit.newText,
          format: input.format,
        }),
      },
    ];
  };

  const renderBlockEdit = (
    block: NativeDocumentBlock,
    edit: NativeDocumentEdit,
  ): RenderItem[] => {
    if (edit.op === 'replace' && edit.newText !== null) {
      return [
        {
          type: 'suggestion',
          key: `edit:${edit.id}`,
          edit,
          mode: 'replace',
          label: pendingLabel(edit),
          currentBlocks: expandedBlocks({
            keyBase: `block:${block.id}:current`,
            kind: block.kind,
            text: block.text,
            format: input.format,
          }),
          proposedBlocks: expandedBlocks({
            keyBase: `edit:${edit.id}:proposed`,
            kind: edit.newKind ?? block.kind,
            text: edit.newText,
            format: input.format,
          }),
        },
      ];
    }

    if (edit.op === 'delete') {
      return [
        {
          type: 'suggestion',
          key: `edit:${edit.id}`,
          edit,
          mode: 'delete',
          label: pendingLabel(edit),
          currentBlocks: expandedBlocks({
            keyBase: `block:${block.id}:current`,
            kind: block.kind,
            text: block.text,
            format: input.format,
          }),
          proposedBlocks: [],
        },
      ];
    }

    return [];
  };

  const renderItems = topInserts.flatMap((edit) => renderInsert(edit));
  const renderedInsertIds = new Set(topInserts.map((edit) => edit.id));

  for (const block of input.blocks) {
    const blockEdits = pendingByBlock.get(block.id) ?? [];
    const blockEditItems = blockEdits.flatMap((edit) =>
      renderBlockEdit(block, edit),
    );
    if (blockEditItems.length > 0) {
      renderItems.push(...blockEditItems);
    } else {
      renderItems.push(...renderBlock(block));
    }

    const anchoredInserts = insertsByAnchor.get(block.id) ?? [];
    renderItems.push(...anchoredInserts.flatMap((edit) => renderInsert(edit)));
    for (const edit of anchoredInserts) renderedInsertIds.add(edit.id);
  }

  const orphanInserts = input.pendingEdits.filter(
    (edit) =>
      edit.op === 'insert' &&
      !renderedInsertIds.has(edit.id) &&
      Boolean(edit.afterBlockId),
  );
  renderItems.push(
    ...orphanInserts.flatMap((edit) =>
      renderInsert(edit, { anchorMissing: true }),
    ),
  );
  return renderItems;
}

function suggestionTitle(mode: SuggestionMode): string {
  if (mode === 'insert') return 'Suggested insertion';
  if (mode === 'delete') return 'Suggested deletion';
  return 'Suggested replacement';
}

function suggestionTone(mode: SuggestionMode): SuggestionTone {
  return mode === 'delete' ? DELETE_TONE : PROPOSE_TONE;
}

function SuggestionHeader({
  edit,
  mode,
  tone,
  label,
  busy,
  disabled,
  canAccept = true,
  onAcceptEdit,
  onRejectEdit,
}: {
  edit: NativeDocumentEdit;
  mode: SuggestionMode;
  tone: SuggestionTone;
  label: string;
  busy: boolean;
  disabled: boolean;
  canAccept?: boolean;
  onAcceptEdit?: (edit: NativeDocumentEdit) => void;
  onRejectEdit?: (edit: NativeDocumentEdit) => void;
}): JSX.Element {
  const canAcceptEdit = Boolean(canAccept && onAcceptEdit);
  const canRejectEdit = Boolean(onRejectEdit);
  const canReview = canAcceptEdit || canRejectEdit;
  const title = suggestionTitle(mode);
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 10,
        flexWrap: 'wrap',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: 8,
          flexWrap: 'wrap',
        }}
      >
        <span
          style={{
            fontSize: 12,
            fontWeight: 700,
            color: salon.ink,
          }}
        >
          {title}
        </span>
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            minHeight: 16,
            padding: '2px 6px',
            borderRadius: 4,
            background: tone.badgeBackground,
            color: '#fff',
            fontFamily: salonFont.mono,
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: 0,
          }}
        >
          {label}
        </span>
      </div>
      {canReview ? (
        <div style={{ display: 'flex', gap: 6 }}>
          {canAcceptEdit ? (
            <Button
              variant="primary"
              disabled={disabled || busy}
              onClick={() => onAcceptEdit?.(edit)}
              aria-label={`Accept inline ${title.toLowerCase()}`}
            >
              {busy ? 'Working...' : 'Accept'}
            </Button>
          ) : null}
          {canRejectEdit ? (
            <Button
              variant="secondary"
              disabled={disabled || busy}
              onClick={() => onRejectEdit?.(edit)}
              aria-label={`Reject inline ${title.toLowerCase()}`}
            >
              Reject
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function SuggestionNotice(): JSX.Element {
  return (
    <div
      style={{
        padding: '8px 10px',
        borderLeft: `2px solid ${DELETE_TONE.accent}`,
        borderRadius: 5,
        background: DELETE_TONE.currentBackground,
        color: salon.ink,
        fontSize: 13,
        lineHeight: 1.45,
      }}
    >
      Original insertion point no longer exists.
    </div>
  );
}

function SuggestionSection({
  label,
  tone,
  reviewTone,
  blocks,
}: {
  label: string;
  tone: 'current' | 'proposed';
  reviewTone: SuggestionTone;
  blocks: DisplayBlock[];
}): JSX.Element {
  const deleted = tone === 'current';
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        padding: '8px 10px',
        borderLeft: `2px solid ${deleted ? DELETE_TONE.accent : reviewTone.accent}`,
        background: deleted
          ? reviewTone.currentBackground
          : reviewTone.proposedBackground,
        borderRadius: 5,
      }}
    >
      <span
        style={{
          fontSize: 10.5,
          fontWeight: 700,
          letterSpacing: 0.3,
          textTransform: 'uppercase',
          color: salon.ink2,
        }}
      >
        {label}
      </span>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {blocks.map((block) => (
          <BlockBody key={block.key} block={block} deleted={deleted} />
        ))}
      </div>
    </div>
  );
}

function SuggestionItem({
  item,
  busy,
  disabled,
  onAcceptEdit,
  onRejectEdit,
}: {
  item: Extract<RenderItem, { type: 'suggestion' }>;
  busy: boolean;
  disabled: boolean;
  onAcceptEdit?: (edit: NativeDocumentEdit) => void;
  onRejectEdit?: (edit: NativeDocumentEdit) => void;
}): JSX.Element {
  const tone = suggestionTone(item.mode);
  return (
    <div
      data-pending="true"
      data-pending-edit-id={item.edit.id}
      style={{
        position: 'relative',
        marginLeft: -12,
        padding: '10px 12px 12px 14px',
        borderLeft: `2px solid ${tone.accent}`,
        borderRadius: 6,
        background: tone.containerBackground,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
    >
      <SuggestionHeader
        edit={item.edit}
        mode={item.mode}
        tone={tone}
        label={item.label}
        busy={busy}
        disabled={disabled}
        canAccept={!item.anchorMissing}
        onAcceptEdit={onAcceptEdit}
        onRejectEdit={onRejectEdit}
      />
      {item.anchorMissing ? <SuggestionNotice /> : null}
      {item.currentBlocks.length > 0 ? (
        <SuggestionSection
          label={item.mode === 'delete' ? 'Will be removed' : 'Current'}
          tone="current"
          reviewTone={tone}
          blocks={item.currentBlocks}
        />
      ) : null}
      {item.proposedBlocks.length > 0 ? (
        <SuggestionSection
          label={
            item.anchorMissing
              ? 'Proposed text'
              : item.mode === 'insert'
                ? 'Insert here'
                : 'Proposed'
          }
          tone="proposed"
          reviewTone={tone}
          blocks={item.proposedBlocks}
        />
      ) : null}
    </div>
  );
}

function BlockBody({
  block,
  deleted = false,
}: {
  block: DisplayBlock;
  deleted?: boolean;
}): JSX.Element {
  const textDecoration = deleted ? 'line-through' : 'none';
  const color = deleted ? salon.ink2 : salon.ink;

  if (block.kind === 'li') {
    return (
      <div
        style={{
          display: 'flex',
          gap: 10,
          padding: '2px 0',
          fontFamily: salonFont.serif,
          fontSize: 15.5,
          lineHeight: 1.7,
          ...BASE_TEXT_STYLE,
          color,
          textDecoration,
        }}
      >
        <span
          aria-hidden="true"
          style={{ color: deleted ? salon.ink2 : salon.accent }}
        >
          •
        </span>
        <span style={{ flex: 1 }}>{block.text}</span>
      </div>
    );
  }
  if (block.kind === 'code') {
    return (
      <pre
        style={{
          margin: 0,
          padding: '10px 12px',
          borderRadius: 8,
          border: `1px solid ${salon.line}`,
          background: 'rgba(255,255,255,0.6)',
          color,
          fontFamily: salonFont.mono,
          fontSize: 12.5,
          lineHeight: 1.55,
          whiteSpace: 'pre-wrap',
          overflowWrap: 'anywhere',
          textDecoration,
        }}
      >
        {block.text}
      </pre>
    );
  }
  if (block.kind === 'h1') {
    return (
      <h1
        style={{
          margin: '0 0 2px',
          fontFamily: salonFont.serif,
          fontSize: 34,
          lineHeight: 1.12,
          fontWeight: 500,
          ...BASE_TEXT_STYLE,
          color,
          textDecoration,
        }}
      >
        {block.text}
      </h1>
    );
  }
  if (block.kind === 'h2') {
    return (
      <h2
        style={{
          margin: '18px 0 4px',
          fontFamily: salonFont.serif,
          fontSize: 22,
          lineHeight: 1.22,
          fontWeight: 500,
          ...BASE_TEXT_STYLE,
          color,
          textDecoration,
        }}
      >
        {block.text}
      </h2>
    );
  }
  if (block.kind === 'meta') {
    return (
      <div
        style={{
          margin: '0 0 8px',
          fontFamily: salonFont.mono,
          fontSize: 10.5,
          lineHeight: 1.5,
          letterSpacing: '0.16em',
          textTransform: 'uppercase',
          ...BASE_TEXT_STYLE,
          color: salon.ink2,
          textDecoration,
        }}
      >
        {block.text}
      </div>
    );
  }
  return (
    <p
      style={{
        margin: 0,
        fontFamily: salonFont.serif,
        fontSize: 16,
        lineHeight: 1.72,
        ...BASE_TEXT_STYLE,
        color,
        textDecoration,
      }}
    >
      {block.text}
    </p>
  );
}

export function DocumentBlocks({
  blocks,
  pendingEdits = [],
  format,
  busyEditIds = new Set<string>(),
  reviewDisabled = false,
  onAcceptEdit,
  onRejectEdit,
}: {
  blocks: NativeDocumentBlock[];
  pendingEdits?: NativeDocumentEdit[];
  format: NativeDocumentFormat;
  busyEditIds?: Set<string>;
  reviewDisabled?: boolean;
  onAcceptEdit?: (edit: NativeDocumentEdit) => void;
  onRejectEdit?: (edit: NativeDocumentEdit) => void;
}): JSX.Element {
  const renderItems = buildRenderItems({ blocks, pendingEdits, format });
  if (renderItems.length === 0) {
    return (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          minHeight: 240,
          gap: 10,
          textAlign: 'center',
          fontSize: 13.5,
          color: salon.ink2,
        }}
      >
        <div
          style={{
            width: 46,
            height: 46,
            borderRadius: '50%',
            border: `1px solid ${salon.line}`,
            background: salon.card,
          }}
        />
        <div
          style={{
            fontFamily: salonFont.serif,
            fontSize: 20,
            color: salon.ink,
          }}
        >
          This tab is empty
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {renderItems.map((item) => {
        if (item.type === 'suggestion') {
          return (
            <SuggestionItem
              key={item.key}
              item={item}
              busy={busyEditIds.has(item.edit.id)}
              disabled={reviewDisabled}
              onAcceptEdit={onAcceptEdit}
              onRejectEdit={onRejectEdit}
            />
          );
        }
        return (
          <div
            key={item.key}
            data-block-kind={item.block.kind}
            style={{
              position: 'relative',
              marginLeft: 0,
              padding: 0,
              borderLeft: '2px solid transparent',
              borderRadius: 0,
              background: 'transparent',
            }}
          >
            <BlockBody block={item.block} />
          </div>
        );
      })}
    </div>
  );
}
