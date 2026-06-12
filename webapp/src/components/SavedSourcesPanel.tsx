import {
  type Dispatch,
  type SetStateAction,
  useEffect,
  useRef,
  useState,
} from 'react';
import {
  createTalkContextSource,
  deleteTalkContextSource,
  getContextSourceContentUrl,
  patchTalkContextSource,
  retryTalkContextSource,
  uploadTalkContextSource,
  UnauthorizedError,
  type ContextSource,
} from '../lib/api';
import { isRasterizablePdf, renderAndUploadPdfPages } from '../lib/pdf-raster';
import { Button, Chip, CTIcon, Input, Textarea } from '../salon';
import { getSourceDisplayRef } from './sourceDisplay';

// Per-source client-side PDF rasterization progress (this session only).
// A PDF is rasterized on upload so vision-but-not-PDF agents can read its
// pages; render runs in the browser (the Worker has no canvas).
type RenderState =
  | { phase: 'rendering'; done: number; total: number }
  | { phase: 'done'; total: number }
  | { phase: 'failed' };

type UploadingFile = {
  localId: string;
  fileName: string;
  status: 'uploading' | 'done' | 'error';
  error?: string;
};

type StatusState =
  | { status: 'idle' }
  | { status: 'saving' }
  | { status: 'success'; message: string }
  | { status: 'error'; message: string };

type SavedSourcesPanelProps = {
  talkId: string;
  sources: ContextSource[];
  setSources: Dispatch<SetStateAction<ContextSource[]>>;
  canEdit: boolean;
  // True when the Talk has at least one agent that supports image vision
  // but NOT native PDF documents — the audience for rasterized PDF pages.
  // Gates the "render pages" affordance on PDFs lacking a complete set.
  hasVisionNonDocAgent: boolean;
  onUnauthorized: () => void;
};

const MAX_FILE_SIZE = 10 * 1024 * 1024;
const ALLOWED_FILE_EXTENSIONS =
  '.pdf,.docx,.xlsx,.pptx,.txt,.md,.csv,.html,.json,.xml,.yaml,.yml,.py,.js,.ts,.jsx,.tsx,.java,.c,.h,.cpp,.hpp,.go,.rs,.sh,.sql,.rtf,.rb,.php,.swift,.kt,.lua,.r,.toml,.ini,.cfg,.log';

function formatFileSize(bytes: number | null | undefined): string | null {
  if (bytes == null) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function SavedSourcesPanel({
  talkId,
  sources,
  setSources,
  canEdit,
  hasVisionNonDocAgent,
  onUnauthorized,
}: SavedSourcesPanelProps): JSX.Element {
  const [status, setStatus] = useState<StatusState>({ status: 'idle' });
  const [uploadingFiles, setUploadingFiles] = useState<UploadingFile[]>([]);
  const [dropActive, setDropActive] = useState(false);
  const [addSourceUrl, setAddSourceUrl] = useState('');
  const [addSourceText, setAddSourceText] = useState('');
  const [addSourceTitle, setAddSourceTitle] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [renderStates, setRenderStates] = useState<Record<string, RenderState>>(
    {},
  );

  // Rasterize a PDF source's pages in the browser and upload them one per
  // request. Runs fire-and-forget after upload (and on manual retry). A
  // failure leaves the source text-only — the page set stays incomplete
  // (count < N) so the server never serves a truncated page run — and a
  // visible notice is shown.
  const rasterizePdfSource = async (
    sourceId: string,
    loadBytes: () => Promise<ArrayBuffer>,
  ): Promise<void> => {
    setRenderStates((prev) => ({
      ...prev,
      [sourceId]: { phase: 'rendering', done: 0, total: 0 },
    }));
    try {
      const data = await loadBytes();
      const result = await renderAndUploadPdfPages({
        talkId,
        sourceId,
        data,
        onProgress: (done, total) =>
          setRenderStates((prev) => ({
            ...prev,
            [sourceId]: { phase: 'rendering', done, total },
          })),
      });
      setRenderStates((prev) => ({
        ...prev,
        [sourceId]:
          result.pagesTotal > 0
            ? { phase: 'done', total: result.pagesTotal }
            : { phase: 'failed' },
      }));
    } catch {
      setRenderStates((prev) => ({
        ...prev,
        [sourceId]: { phase: 'failed' },
      }));
    }
  };

  // Manual re-render: re-fetch the stored PDF bytes from R2 (the original
  // File is gone after a reload) and rasterize again.
  const handleRetryRender = (sourceId: string): void => {
    void rasterizePdfSource(sourceId, () =>
      fetch(getContextSourceContentUrl(talkId, sourceId), {
        credentials: 'include',
      }).then((res) => {
        if (!res.ok) throw new Error(`Failed to load PDF (${res.status})`);
        return res.arrayBuffer();
      }),
    );
  };

  function handleApiError(err: unknown, fallback: string): void {
    if (err instanceof UnauthorizedError) {
      onUnauthorized();
      return;
    }
    setStatus({
      status: 'error',
      message: err instanceof Error ? err.message : fallback,
    });
  }

  const handleAddUrl = async () => {
    const trimmedUrl = addSourceUrl.trim();
    if (!trimmedUrl) return;
    setStatus({ status: 'saving' });
    try {
      const source = await createTalkContextSource({
        talkId,
        sourceType: 'url',
        title: addSourceTitle.trim() || trimmedUrl,
        sourceUrl: trimmedUrl,
      });
      setSources((prev) => [...prev, source]);
      setAddSourceTitle('');
      setAddSourceUrl('');
      setStatus({ status: 'idle' });
    } catch (err) {
      handleApiError(err, 'Failed to add source.');
    }
  };

  const handleAddText = async () => {
    const trimmedText = addSourceText.trim();
    if (!trimmedText) return;
    setStatus({ status: 'saving' });
    try {
      const source = await createTalkContextSource({
        talkId,
        sourceType: 'text',
        title: addSourceTitle.trim() || 'Pasted text source',
        extractedText: trimmedText,
      });
      setSources((prev) => [...prev, source]);
      setAddSourceTitle('');
      setAddSourceText('');
      setStatus({ status: 'idle' });
    } catch (err) {
      handleApiError(err, 'Failed to add text source.');
    }
  };

  const handleFilesSelected = async (files: FileList | File[]) => {
    const fileArr = Array.from(files);
    if (fileArr.length === 0) return;

    for (const file of fileArr) {
      const localId = `upload_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      if (file.size > MAX_FILE_SIZE) {
        setUploadingFiles((prev) => [
          ...prev,
          {
            localId,
            fileName: file.name,
            status: 'error',
            error: 'File exceeds 10 MB limit',
          },
        ]);
        continue;
      }

      setUploadingFiles((prev) => [
        ...prev,
        { localId, fileName: file.name, status: 'uploading' },
      ]);

      try {
        const source = await uploadTalkContextSource(talkId, file);
        setSources((prev) => [...prev, source]);
        setUploadingFiles((prev) =>
          prev.map((f) =>
            f.localId === localId ? { ...f, status: 'done' as const } : f,
          ),
        );
        setTimeout(() => {
          setUploadingFiles((prev) =>
            prev.filter((f) => f.localId !== localId),
          );
        }, 1500);
        // Every uploaded PDF is rasterized so vision-but-not-PDF agents
        // (gpt-5-mini, gemini, kimi) can read its pages. Fire-and-forget;
        // the source is already usable as text while pages render.
        if (isRasterizablePdf(file.type)) {
          void rasterizePdfSource(source.id, () => file.arrayBuffer());
        }
      } catch (err) {
        if (err instanceof UnauthorizedError) {
          onUnauthorized();
          return;
        }
        setUploadingFiles((prev) =>
          prev.map((f) =>
            f.localId === localId
              ? {
                  ...f,
                  status: 'error' as const,
                  error: err instanceof Error ? err.message : 'Upload failed',
                }
              : f,
          ),
        );
      }
    }
  };

  const handleDelete = async (sourceId: string) => {
    try {
      await deleteTalkContextSource({ talkId, sourceId });
      setSources((prev) => prev.filter((s) => s.id !== sourceId));
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      // Match the pre-extraction behavior: silent on delete-failure.
    }
  };

  const handleRetry = async (sourceId: string) => {
    try {
      const updated = await retryTalkContextSource({ talkId, sourceId });
      setSources((prev) =>
        prev.map((source) => (source.id === updated.id ? updated : source)),
      );
      setStatus({
        status: 'success',
        message: 'Retrying saved source fetch.',
      });
    } catch (err) {
      handleApiError(err, 'Failed to retry saved source.');
    }
  };

  const handlePatchTitle = async (
    sourceId: string,
    nextTitle: string,
  ): Promise<void> => {
    const trimmed = nextTitle.trim();
    if (!trimmed) throw new Error('Title cannot be empty.');
    const updated = await patchTalkContextSource({
      talkId,
      sourceId,
      title: trimmed,
    });
    setSources((prev) =>
      prev.map((source) => (source.id === updated.id ? updated : source)),
    );
  };

  const handlePatchNote = async (
    sourceId: string,
    nextNote: string,
  ): Promise<void> => {
    const trimmed = nextNote.trim();
    const updated = await patchTalkContextSource({
      talkId,
      sourceId,
      note: trimmed ? trimmed : null,
    });
    setSources((prev) =>
      prev.map((source) => (source.id === updated.id ? updated : source)),
    );
  };

  return (
    <section className="talk-context-card">
      <div className="talk-context-card-header">
        <div>
          <h3>Saved Sources</h3>
          <p className="talk-context-card-copy">
            Files, URLs, and text snippets agents can reference. Each source
            contributes a one-line preview to every turn. Use the @ picker or{' '}
            <code>@title-slug</code> in a message to inline a source's full
            content for one turn.
          </p>
        </div>
      </div>

      {canEdit ? (
        <>
          <div
            className={`context-source-dropzone${dropActive ? ' context-source-dropzone-active' : ''}`}
            role="button"
            tabIndex={0}
            aria-label="Upload saved source files"
            onClick={() => fileInputRef.current?.click()}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                fileInputRef.current?.click();
              }
            }}
            // Intercept dragEnter alongside the other handlers so files
            // dragged onto this dropzone stay scoped to saved-source upload.
            onDragEnter={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setDropActive(true);
            }}
            onDragOver={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setDropActive(true);
            }}
            onDragLeave={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setDropActive(false);
            }}
            onDrop={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setDropActive(false);
              if (e.dataTransfer.files.length > 0)
                void handleFilesSelected(e.dataTransfer.files);
            }}
          >
            <span>Drop files here or click to browse</span>
            <span className="context-source-dropzone-hint">
              PDF, DOCX, XLSX, text, code files up to 10 MB
            </span>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            style={{ display: 'none' }}
            accept={ALLOWED_FILE_EXTENSIONS}
            onChange={(e) => {
              if (e.target.files && e.target.files.length > 0) {
                void handleFilesSelected(e.target.files);
                e.target.value = '';
              }
            }}
          />
        </>
      ) : null}

      {uploadingFiles.length > 0 ? (
        <div className="context-source-upload-progress" role="status">
          {uploadingFiles.map((f) => (
            <div key={f.localId} className="context-source-upload-item">
              <span>{f.fileName}</span>
              {f.status === 'uploading' ? (
                <span className="context-source-upload-status">
                  Uploading...
                </span>
              ) : f.status === 'error' ? (
                <span
                  className="context-source-upload-status"
                  style={{ color: 'var(--danger-text, #a61b1b)' }}
                >
                  {f.error || 'Failed'}
                </span>
              ) : (
                <span
                  className="context-source-upload-status"
                  style={{ color: 'green' }}
                >
                  Done
                </span>
              )}
            </div>
          ))}
        </div>
      ) : null}

      {sources.length > 0 ? (
        <ul className="context-source-list">
          {sources.map((source, index) => (
            <SavedSourceRow
              key={source.id}
              source={source}
              displayIndex={index}
              canEdit={canEdit}
              hasVisionNonDocAgent={hasVisionNonDocAgent}
              renderState={renderStates[source.id]}
              onPatchTitle={handlePatchTitle}
              onPatchNote={handlePatchNote}
              onRetry={handleRetry}
              onRetryRender={handleRetryRender}
              onDelete={handleDelete}
            />
          ))}
        </ul>
      ) : uploadingFiles.length === 0 ? (
        <p className="talk-context-empty">No sources yet.</p>
      ) : null}

      {canEdit ? (
        <div className="talk-context-source-create">
          <label className="talk-context-field">
            <span className="talk-context-field-label">
              Source title (optional)
            </span>
            <Input
              type="text"
              value={addSourceTitle}
              onChange={(e) => setAddSourceTitle(e.target.value)}
              placeholder="Source title"
              disabled={status.status === 'saving'}
            />
          </label>
          <div className="talk-context-source-mode-row">
            <label className="talk-context-field talk-context-field-fill">
              <span className="talk-context-field-label">URL</span>
              <Input
                type="url"
                value={addSourceUrl}
                onChange={(e) => setAddSourceUrl(e.target.value)}
                placeholder="https://example.com/docs"
                disabled={status.status === 'saving'}
              />
            </label>
            <Button
              variant="secondary"
              onClick={() => void handleAddUrl()}
              disabled={status.status === 'saving' || !addSourceUrl.trim()}
            >
              Add URL
            </Button>
          </div>
          <label className="talk-context-field">
            <span className="talk-context-field-label">Paste text snippet</span>
            <Textarea
              value={addSourceText}
              onChange={(e) => setAddSourceText(e.target.value)}
              placeholder="Paste notes, source excerpts, or working context here…"
              rows={4}
              disabled={status.status === 'saving'}
              className="talk-context-textarea"
              style={{ resize: 'vertical' }}
            />
          </label>
          <div className="talk-context-actions-row">
            <Button
              variant="secondary"
              onClick={() => void handleAddText()}
              disabled={status.status === 'saving' || !addSourceText.trim()}
            >
              Add Text
            </Button>
          </div>
        </div>
      ) : null}

      {status.status === 'error' ? (
        <p className="talk-context-status talk-context-status-error">
          {status.message}
        </p>
      ) : status.status === 'success' ? (
        <p className="talk-context-status">{status.message}</p>
      ) : null}
    </section>
  );
}

type SavedSourceRowProps = {
  source: ContextSource;
  displayIndex: number;
  canEdit: boolean;
  hasVisionNonDocAgent: boolean;
  renderState: RenderState | undefined;
  onPatchTitle: (sourceId: string, nextTitle: string) => Promise<void>;
  onPatchNote: (sourceId: string, nextNote: string) => Promise<void>;
  onRetry: (sourceId: string) => Promise<void>;
  onRetryRender: (sourceId: string) => void;
  onDelete: (sourceId: string) => Promise<void>;
};

function SavedSourceRow({
  source,
  displayIndex,
  canEdit,
  hasVisionNonDocAgent,
  renderState,
  onPatchTitle,
  onPatchNote,
  onRetry,
  onRetryRender,
  onDelete,
}: SavedSourceRowProps): JSX.Element {
  const isPdf = source.mimeType === 'application/pdf';
  // Offer to rasterize a PDF that lacks a complete page set when the Talk
  // has a vision-but-not-PDF agent — but only when it isn't already being
  // rendered this session (renderState owns that UI). pageSetComplete is
  // the backend's resolved boolean (not recomputed here).
  const showRenderAffordance =
    canEdit &&
    isPdf &&
    hasVisionNonDocAgent &&
    !source.pageSetComplete &&
    !renderState;
  const fileSizeLabel = formatFileSize(source.fileSize);
  const extractedLabel =
    source.extractedTextLength != null
      ? `${source.extractedTextLength} chars extracted`
      : null;
  const displayRef = getSourceDisplayRef(source, displayIndex);

  return (
    <li className="context-source-item">
      <div className="context-source-item-row">
        <span
          className="context-source-ref"
          title="Pick this source from the @ menu or use @title-slug to inline its full content for one turn."
        >
          {displayRef}
        </span>
        <Chip tone="ghost">
          {source.sourceType === 'file'
            ? 'File'
            : source.sourceType === 'url'
              ? 'URL'
              : 'Text'}
        </Chip>
        <div className="context-source-title">
          <InlineEditable
            value={source.title}
            placeholder="Untitled source"
            disabled={!canEdit}
            ariaLabel="Edit source title"
            requireNonEmpty
            onSave={(next) => onPatchTitle(source.id, next)}
          />
        </div>
        <div className="context-source-row-meta">
          {source.sourceType === 'file' && fileSizeLabel ? (
            <span className="context-source-file-meta">{fileSizeLabel}</span>
          ) : null}
          {source.fetchStrategy ? (
            <span className="context-source-file-meta">
              via {source.fetchStrategy}
            </span>
          ) : null}
          <span
            className={`context-source-status context-source-status-${source.status}`}
          >
            {source.status}
          </span>
        </div>
        {canEdit &&
        source.sourceType === 'url' &&
        source.status === 'failed' ? (
          <Button
            variant="secondary"
            onClick={() => void onRetry(source.id)}
            style={{ height: 30, padding: '0 12px' }}
          >
            Retry
          </Button>
        ) : null}
        {canEdit ? (
          <Button
            variant="ghost"
            onClick={() => void onDelete(source.id)}
            title="Remove source"
            aria-label={`Remove ${source.title || 'source'}`}
            style={{
              width: 32,
              height: 32,
              minWidth: 32,
              padding: 0,
            }}
          >
            <CTIcon name="x" size={14} strokeWidth={1.8} />
          </Button>
        ) : null}
      </div>
      <div className="context-source-note">
        <InlineEditable
          value={source.note ?? ''}
          placeholder="Add a one-line routing hint (when to use this source)"
          disabled={!canEdit}
          ariaLabel="Edit source note"
          onSave={(next) => onPatchNote(source.id, next)}
        />
      </div>
      {extractedLabel ? (
        <p className="context-source-detail">
          {extractedLabel}
          {source.isTruncated ? ' (truncated)' : ''}
        </p>
      ) : null}
      {source.extractionError ? (
        <p className="context-source-error">{source.extractionError}</p>
      ) : null}
      {source.lastFetchedAt ? (
        <p className="context-source-detail">
          Last fetched {new Date(source.lastFetchedAt).toLocaleString()}
        </p>
      ) : null}
      {renderState ? (
        <p
          className={`context-source-detail${
            renderState.phase === 'failed' ? ' context-source-warning' : ''
          }`}
        >
          {renderState.phase === 'rendering'
            ? `Rendering pages for vision agents…${
                renderState.total > 0
                  ? ` ${renderState.done}/${renderState.total}`
                  : ''
              }`
            : renderState.phase === 'done'
              ? `${renderState.total} page${
                  renderState.total === 1 ? '' : 's'
                } rendered for image-only vision agents.`
              : "Couldn't render this PDF's pages — it stays text-only for image-only vision agents."}
          {renderState.phase === 'failed' && canEdit ? (
            <Button
              variant="secondary"
              className="context-source-inline-action"
              onClick={() => onRetryRender(source.id)}
            >
              Retry
            </Button>
          ) : null}
        </p>
      ) : null}
      {showRenderAffordance ? (
        <p className="context-source-detail">
          Not yet rendered for image-only vision agents.
          <Button
            variant="secondary"
            className="context-source-inline-action"
            onClick={() => onRetryRender(source.id)}
          >
            Render pages
          </Button>
        </p>
      ) : isPdf && source.pageSetComplete && !renderState ? (
        <p className="context-source-detail">
          {source.pageImageCount} page{source.pageImageCount === 1 ? '' : 's'}{' '}
          rendered for image-only vision agents.
        </p>
      ) : null}
    </li>
  );
}

type InlineEditableProps = {
  value: string;
  placeholder: string;
  ariaLabel: string;
  disabled?: boolean;
  requireNonEmpty?: boolean;
  onSave: (next: string) => Promise<void>;
};

function InlineEditable({
  value,
  placeholder,
  ariaLabel,
  disabled,
  requireNonEmpty,
  onSave,
}: InlineEditableProps): JSX.Element {
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const saveOnBlurRef = useRef(true);

  useEffect(() => {
    if (!isEditing) {
      setDraft(value);
      setError(null);
    }
  }, [isEditing, value]);

  useEffect(() => {
    if (!isEditing) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [isEditing]);

  async function commit(nextValue: string): Promise<void> {
    const trimmed = nextValue.trim();
    if (requireNonEmpty && !trimmed) {
      setError('Cannot be empty.');
      return;
    }
    if (trimmed === value.trim()) {
      setIsEditing(false);
      setError(null);
      return;
    }
    setIsSaving(true);
    setError(null);
    try {
      await onSave(trimmed);
      setIsEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed.');
    } finally {
      setIsSaving(false);
    }
  }

  if (!isEditing) {
    return (
      <button
        type="button"
        className="salon-btn saved-sources-inline-edit-button"
        onClick={() => {
          if (disabled) return;
          setIsEditing(true);
        }}
        aria-label={ariaLabel}
        title={disabled ? undefined : ariaLabel}
        disabled={disabled}
      >
        {value && value.length > 0 ? (
          <span>{value}</span>
        ) : (
          <span style={{ opacity: 0.5 }}>{placeholder}</span>
        )}
      </button>
    );
  }

  return (
    <span className="saved-sources-inline-edit-wrap">
      <input
        ref={inputRef}
        className="salon-field saved-sources-inline-edit-input"
        type="text"
        value={draft}
        aria-label={ariaLabel}
        disabled={isSaving}
        placeholder={placeholder}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            void commit(draft);
          } else if (event.key === 'Escape') {
            event.preventDefault();
            saveOnBlurRef.current = false;
            setDraft(value);
            setIsEditing(false);
            setError(null);
          }
        }}
        onBlur={() => {
          const shouldSave = saveOnBlurRef.current;
          saveOnBlurRef.current = true;
          if (shouldSave) {
            void commit(draft);
          }
        }}
      />
      {error ? (
        <span
          style={{
            display: 'block',
            color: 'var(--danger-text, #a61b1b)',
            fontSize: '0.75rem',
          }}
          role="alert"
        >
          {error}
        </span>
      ) : null}
    </span>
  );
}
