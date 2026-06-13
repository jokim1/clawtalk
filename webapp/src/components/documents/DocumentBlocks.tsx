/**
 * Presentational renderer for a native document tab's blocks.
 *
 * Native storage is still block-kind + text. This view expands Markdown/HTML-ish
 * text into readable blocks and overlays pending edits inline so accepting a run
 * removes the accent treatment instead of leaving a disconnected review card.
 */
import { salon, salonFont } from '../../salon';
import type {
  NativeDocumentBlock,
  NativeDocumentEdit,
  NativeDocumentFormat,
} from '../../lib/api';
import { parseDocumentDisplayBlocks } from './documentText';

type RenderBlock = {
  key: string;
  kind: NativeDocumentBlock['kind'];
  text: string;
  pendingLabel: string | null;
  pendingMode: 'replace' | 'insert' | 'delete' | null;
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
  pendingLabel: string | null;
  pendingMode: RenderBlock['pendingMode'];
}): RenderBlock[] {
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
    pendingLabel: index === 0 ? input.pendingLabel : null,
    pendingMode: input.pendingMode,
  }));
}

function buildRenderBlocks(input: {
  blocks: NativeDocumentBlock[];
  pendingEdits: NativeDocumentEdit[];
  format: NativeDocumentFormat;
}): RenderBlock[] {
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

  const renderInsert = (edit: NativeDocumentEdit): RenderBlock[] => {
    if (edit.newText === null) return [];
    return expandedBlocks({
      keyBase: `edit:${edit.id}`,
      kind: edit.newKind ?? 'p',
      text: edit.newText,
      format: input.format,
      pendingLabel: pendingLabel(edit),
      pendingMode: 'insert',
    });
  };

  const renderBlocks = topInserts.flatMap(renderInsert);
  const renderedInsertIds = new Set(topInserts.map((edit) => edit.id));

  for (const block of input.blocks) {
    const blockEdits = pendingByBlock.get(block.id) ?? [];
    const overlay = blockEdits[0] ?? null;
    if (overlay?.op === 'replace' && overlay.newText !== null) {
      renderBlocks.push(
        ...expandedBlocks({
          keyBase: `edit:${overlay.id}`,
          kind: overlay.newKind ?? block.kind,
          text: overlay.newText,
          format: input.format,
          pendingLabel: pendingLabel(overlay),
          pendingMode: 'replace',
        }),
      );
    } else {
      renderBlocks.push(
        ...expandedBlocks({
          keyBase: `block:${block.id}`,
          kind: block.kind,
          text: block.text,
          format: input.format,
          pendingLabel: overlay?.op === 'delete' ? pendingLabel(overlay) : null,
          pendingMode: overlay?.op === 'delete' ? 'delete' : null,
        }),
      );
    }

    const anchoredInserts = insertsByAnchor.get(block.id) ?? [];
    renderBlocks.push(...anchoredInserts.flatMap(renderInsert));
    for (const edit of anchoredInserts) renderedInsertIds.add(edit.id);
  }

  const orphanInserts = input.pendingEdits.filter(
    (edit) =>
      edit.op === 'insert' &&
      !renderedInsertIds.has(edit.id) &&
      edit.tabId === input.blocks[0]?.tabId,
  );
  renderBlocks.push(...orphanInserts.flatMap(renderInsert));
  return renderBlocks;
}

function PendingBadge({
  label,
  mode,
}: {
  label: string;
  mode: Exclude<RenderBlock['pendingMode'], null>;
}): JSX.Element {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        minHeight: 16,
        marginLeft: 8,
        padding: '2px 6px',
        borderRadius: 4,
        background: mode === 'delete' ? '#7b2a30' : salon.accent,
        color: '#fff',
        fontFamily: salonFont.mono,
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: 0,
        verticalAlign: 'middle',
      }}
      title={`${label}; review this proposal in Pending edits.`}
    >
      {label}
    </span>
  );
}

function BlockBody({ block }: { block: RenderBlock }): JSX.Element {
  const deleted = block.pendingMode === 'delete';
  const textDecoration = deleted ? 'line-through' : 'none';
  const color = deleted ? salon.ink2 : salon.ink;
  const badge =
    block.pendingLabel && block.pendingMode ? (
      <PendingBadge label={block.pendingLabel} mode={block.pendingMode} />
    ) : null;

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
        <span style={{ flex: 1 }}>
          {block.text}
          {badge}
        </span>
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
        {badge}
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
        {badge}
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
        {badge}
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
      {badge}
    </p>
  );
}

export function DocumentBlocks({
  blocks,
  pendingEdits = [],
  format,
}: {
  blocks: NativeDocumentBlock[];
  pendingEdits?: NativeDocumentEdit[];
  format: NativeDocumentFormat;
}): JSX.Element {
  const renderBlocks = buildRenderBlocks({ blocks, pendingEdits, format });
  if (renderBlocks.length === 0) {
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
      {renderBlocks.map((block) => {
        const pending = block.pendingMode !== null;
        return (
          <div
            key={block.key}
            data-block-kind={block.kind}
            data-pending={pending ? 'true' : undefined}
            style={{
              position: 'relative',
              marginLeft: pending ? -12 : 0,
              padding: pending ? '8px 10px 8px 14px' : 0,
              borderLeft: pending
                ? `2px solid ${block.pendingMode === 'delete' ? '#7b2a30' : salon.accent}`
                : '2px solid transparent',
              borderRadius: pending ? 5 : 0,
              background: pending
                ? block.pendingMode === 'delete'
                  ? 'rgba(123,42,48,0.08)'
                  : 'rgba(200,100,58,0.08)'
                : 'transparent',
            }}
          >
            <BlockBody block={block} />
          </div>
        );
      })}
    </div>
  );
}
