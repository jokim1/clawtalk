import type { FormEvent, RefObject } from 'react';

import type { NativeDocumentFormat } from '../../lib/api';

type TalkDocumentCreateModalProps = {
  title: string;
  format: NativeDocumentFormat;
  submitting: boolean;
  error: string | null;
  inputRef: RefObject<HTMLInputElement>;
  onTitleChange: (title: string) => void;
  onFormatChange: (format: NativeDocumentFormat) => void;
  onClose: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
};

export function TalkDocumentCreateModal({
  title,
  format,
  submitting,
  error,
  inputRef,
  onTitleChange,
  onFormatChange,
  onClose,
  onSubmit,
}: TalkDocumentCreateModalProps): JSX.Element {
  return (
    <div
      className="doc-promote-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="doc-promote-modal-title"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <form className="doc-promote-modal" onSubmit={onSubmit}>
        <h3 id="doc-promote-modal-title">Add a document</h3>
        <label className="doc-promote-modal-label" htmlFor="doc-promote-modal-input">
          Title
        </label>
        <input
          id="doc-promote-modal-input"
          ref={inputRef}
          type="text"
          className="doc-promote-modal-input"
          value={title}
          onChange={(event) => onTitleChange(event.target.value)}
          placeholder="Untitled document"
          maxLength={160}
          disabled={submitting}
          autoComplete="off"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              onClose();
            }
          }}
        />
        <fieldset className="doc-promote-modal-format" disabled={submitting}>
          <legend className="doc-promote-modal-label">Format</legend>
          <label className="doc-promote-modal-format-option">
            <input
              type="radio"
              name="doc-promote-modal-format"
              value="markdown"
              checked={format === 'markdown'}
              onChange={() => onFormatChange('markdown')}
            />
            Markdown
          </label>
          <label className="doc-promote-modal-format-option">
            <input
              type="radio"
              name="doc-promote-modal-format"
              value="html"
              checked={format === 'html'}
              onChange={() => onFormatChange('html')}
            />
            HTML
          </label>
        </fieldset>
        {error ? (
          <p className="doc-promote-modal-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="doc-promote-modal-actions">
          <button
            type="button"
            className="doc-promote-modal-cancel"
            onClick={onClose}
            disabled={submitting}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="doc-promote-modal-submit"
            disabled={submitting || !title.trim()}
          >
            {submitting ? 'Creating…' : 'Create document'}
          </button>
        </div>
      </form>
    </div>
  );
}
