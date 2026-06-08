/**
 * In-Talk document pane shown beside the conversation (the canonical
 * "Talk+doc pane" split surface).
 *
 * Reads ONLY the native `documents`/`doc_tabs`/`doc_blocks`/`document_edits`
 * model via `TalkDocumentView` — never the legacy flat content body facade.
 * This replaced the legacy split-editor (RichTextEditor /
 * HtmlSourceEditor / PendingEditDocSurface) whose authoring affordances are
 * deferred post-MVP per the canonical product spec; the in-Talk surface is
 * read + accept/reject review.
 *
 * The document id is resolved by the page from the snapshot's primary-document
 * id and handed in, so this component stays presentational. Live agent edits
 * arrive via `reloadSignal`, which `TalkDocumentView` turns into a quiet native
 * reload.
 */
import type { RefObject } from 'react';

import { TalkDocumentView } from './TalkDocumentView';

export interface TalkDocPaneProps {
  documentId: string;
  workspaceId: string | null;
  canEditDoc: boolean;
  onUnauthorized: () => void;
  /** Bumped by the Talk run stream on each content-edit event for this doc. */
  reloadSignal: number;
  onHidePane: () => void;
  docBodyRef: RefObject<HTMLDivElement>;
}

export function TalkDocPane({
  documentId,
  workspaceId,
  canEditDoc,
  onUnauthorized,
  reloadSignal,
  onHidePane,
  docBodyRef,
}: TalkDocPaneProps): JSX.Element {
  return (
    <>
      <div className="talk-doc-pane-chrome">
        <button
          type="button"
          className="doc-pane-hide-btn"
          aria-label="Hide document pane"
          aria-pressed={false}
          onClick={onHidePane}
          title="Hide document pane"
        >
          <span aria-hidden="true" className="doc-pane-hide-glyph">
            ›
          </span>
        </button>
      </div>
      <div
        className="talk-tab-doc-body talk-tab-doc-body-native"
        ref={docBodyRef}
        tabIndex={-1}
      >
        <TalkDocumentView
          documentId={documentId}
          workspaceId={workspaceId}
          canEditDoc={canEditDoc}
          onUnauthorized={onUnauthorized}
          reloadSignal={reloadSignal}
        />
      </div>
    </>
  );
}
