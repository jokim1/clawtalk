/**
 * Talk Documents tab — surfaces the Talk's primary native document for viewing
 * and pending-edit review.
 *
 * A Talk has zero or one primary document (`documents.primary_talk_id`, enforced
 * unique). The native list route has no by-talk filter, so we resolve the doc id
 * client-side from `listDocuments` (scoped to the Talk's workspace) by matching
 * `primaryTalkId`, then hand off to `TalkDocumentView`. No markdown/html facade
 * read anywhere — only the native `documents`/`doc_blocks`/`document_edits`.
 *
 * Self-contained (TalkToolsPanel shape): the page passes only ids + capability
 * flags. The tab unmounts on switch and re-fetches on remount, so there is no
 * page-owned state to keep in sync.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { Button, salon } from '../../salon';
import {
  listDocuments,
  UnauthorizedError,
  type NativeDocumentSummary,
} from '../../lib/api';
import { TalkDocumentView } from './TalkDocumentView';

export interface TalkDocumentsPanelProps {
  talkId: string;
  /** The Talk's workspace; null until the snapshot resolves. */
  workspaceId: string | null;
  canEditDoc: boolean;
  onUnauthorized: () => void;
}

type ListState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; primary: NativeDocumentSummary | null };

export function TalkDocumentsPanel({
  talkId,
  workspaceId,
  canEditDoc,
  onUnauthorized,
}: TalkDocumentsPanelProps): JSX.Element {
  const [state, setState] = useState<ListState>({ status: 'loading' });
  const activeLoad = useRef<{ cancelled: boolean } | null>(null);

  const load = useCallback(async () => {
    // Wait for the Talk workspace so the list is scoped correctly; the effect
    // re-runs once `workspaceId` resolves.
    if (!workspaceId) return;
    if (activeLoad.current) activeLoad.current.cancelled = true;
    const signal = { cancelled: false };
    activeLoad.current = signal;
    setState({ status: 'loading' });
    try {
      const documents = await listDocuments({ workspaceId });
      if (signal.cancelled) return;
      const primary =
        documents.find((doc) => doc.primaryTalkId === talkId) ?? null;
      setState({ status: 'ready', primary });
    } catch (err) {
      if (signal.cancelled) return;
      if (err instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      setState({
        status: 'error',
        message:
          err instanceof Error
            ? err.message
            : 'Documents are unavailable right now.',
      });
    }
  }, [onUnauthorized, talkId, workspaceId]);

  useEffect(() => {
    void load();
    return () => {
      if (activeLoad.current) activeLoad.current.cancelled = true;
    };
  }, [load]);

  return (
    <section
      className="ct-screen-enter ct-thin-scroll"
      aria-label="Talk documents"
      style={{
        width: '100%',
        maxWidth: 820,
        margin: '0 auto',
        padding: '20px 20px 48px',
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
      }}
    >
      {state.status === 'loading' ? (
        <div aria-busy="true" aria-label="Loading documents">
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
      ) : null}

      {state.status === 'error' ? (
        <PanelCard>
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
        </PanelCard>
      ) : null}

      {state.status === 'ready' ? (
        state.primary ? (
          <TalkDocumentView
            key={state.primary.id}
            documentId={state.primary.id}
            workspaceId={workspaceId}
            canEditDoc={canEditDoc}
          />
        ) : (
          <PanelCard>
            <div
              style={{
                textAlign: 'center',
                padding: '24px 12px',
                color: salon.ink2,
                fontSize: 13.5,
              }}
            >
              No document is attached to this Talk yet. When an agent drafts one
              here, it shows up in this pane for you to read and review.
            </div>
          </PanelCard>
        )
      ) : null}
    </section>
  );
}

function PanelCard({ children }: { children: React.ReactNode }): JSX.Element {
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
