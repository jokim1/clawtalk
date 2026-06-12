import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';

import { CTIcon, type CTIconName } from '../../salon';

export interface TalkSidePanelShellProps {
  talkId: string;
  title: string;
  subtitle?: string;
  icon: CTIconName;
  onClose: () => void;
  children: ReactNode;
}

const SIDE_PANEL_DEFAULT_WIDTH = 384;
const SIDE_PANEL_MIN_WIDTH = 320;
const SIDE_PANEL_MAX_WIDTH = 720;
const SIDE_PANEL_REMAINING_CONTENT_MIN = 320;
const SIDE_PANEL_STEP = 24;

function getSidePanelStorageKey(talkId: string): string {
  return `clawtalk_side_panel:${talkId}`;
}

function getViewportMaxWidth(): number {
  if (typeof window === 'undefined') return SIDE_PANEL_MAX_WIDTH;
  return Math.max(
    SIDE_PANEL_MIN_WIDTH,
    Math.min(
      SIDE_PANEL_MAX_WIDTH,
      window.innerWidth - SIDE_PANEL_REMAINING_CONTENT_MIN,
    ),
  );
}

function clampSidePanelWidth(value: number): number {
  if (!Number.isFinite(value)) return SIDE_PANEL_DEFAULT_WIDTH;
  return Math.max(SIDE_PANEL_MIN_WIDTH, Math.min(getViewportMaxWidth(), value));
}

function readPersistedSidePanelWidth(talkId: string): number {
  if (typeof window === 'undefined') return SIDE_PANEL_DEFAULT_WIDTH;
  try {
    const raw = window.localStorage.getItem(getSidePanelStorageKey(talkId));
    if (!raw) return clampSidePanelWidth(SIDE_PANEL_DEFAULT_WIDTH);
    const parsed = JSON.parse(raw) as { width?: unknown };
    return clampSidePanelWidth(
      typeof parsed.width === 'number' ? parsed.width : SIDE_PANEL_DEFAULT_WIDTH,
    );
  } catch {
    return clampSidePanelWidth(SIDE_PANEL_DEFAULT_WIDTH);
  }
}

function writePersistedSidePanelWidth(talkId: string, width: number): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(
      getSidePanelStorageKey(talkId),
      JSON.stringify({ width }),
    );
  } catch {
    // Quota / private mode; silently ignore.
  }
}

function isNarrowSidePanelViewport(): boolean {
  if (typeof window === 'undefined') return false;
  if (typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(max-width: 768px)').matches;
}

export function TalkSidePanelShell({
  talkId,
  title,
  subtitle,
  icon,
  onClose,
  children,
}: TalkSidePanelShellProps): JSX.Element {
  const panelRef = useRef<HTMLElement | null>(null);
  const resizingRef = useRef(false);
  const rightEdgeRef = useRef(0);
  const [panelWidth, setPanelWidth] = useState(() =>
    readPersistedSidePanelWidth(talkId),
  );
  const [isNarrowViewport, setIsNarrowViewport] = useState(() =>
    isNarrowSidePanelViewport(),
  );

  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  useEffect(() => {
    setPanelWidth(readPersistedSidePanelWidth(talkId));
  }, [talkId]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(max-width: 768px)');
    const onChange = (event: MediaQueryListEvent) =>
      setIsNarrowViewport(event.matches);
    setIsNarrowViewport(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const applyPanelWidth = useCallback(
    (nextRaw: number) => {
      const next = clampSidePanelWidth(nextRaw);
      setPanelWidth(next);
      writePersistedSidePanelWidth(talkId, next);
    },
    [talkId],
  );

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onResize = () => {
      setPanelWidth((current) => {
        const next = clampSidePanelWidth(current);
        if (next !== current) writePersistedSidePanelWidth(talkId, next);
        return next;
      });
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [talkId]);

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    onClose();
  };

  const handleResizeKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      applyPanelWidth(panelWidth + SIDE_PANEL_STEP);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      applyPanelWidth(panelWidth - SIDE_PANEL_STEP);
    } else if (event.key === 'Home') {
      event.preventDefault();
      applyPanelWidth(SIDE_PANEL_MIN_WIDTH);
    } else if (event.key === 'End') {
      event.preventDefault();
      applyPanelWidth(getViewportMaxWidth());
    }
  };

  const handleResizePointerDown = (
    event: ReactPointerEvent<HTMLDivElement>,
  ) => {
    event.preventDefault();
    resizingRef.current = true;
    rightEdgeRef.current =
      panelRef.current?.getBoundingClientRect().right ?? window.innerWidth;
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handleResizePointerMove = (
    event: ReactPointerEvent<HTMLDivElement>,
  ) => {
    if (!resizingRef.current) return;
    event.preventDefault();
    applyPanelWidth(rightEdgeRef.current - event.clientX);
  };

  const handleResizePointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    resizingRef.current = false;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const panelStyle: CSSProperties | undefined = isNarrowViewport
    ? undefined
    : {
        width: panelWidth,
        flexBasis: panelWidth,
      };
  const maxWidth = getViewportMaxWidth();

  return (
    <>
      <button
        type="button"
        className="talk-side-panel-backdrop"
        onClick={onClose}
        aria-hidden="true"
        tabIndex={-1}
      />
      <aside
        ref={panelRef}
        className="talk-side-panel ct-screen-enter"
        aria-label={title}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
        style={panelStyle}
      >
        {!isNarrowViewport ? (
          <div
            className="talk-side-panel-resize-handle"
            role="separator"
            aria-orientation="vertical"
            aria-valuemin={SIDE_PANEL_MIN_WIDTH}
            aria-valuemax={maxWidth}
            aria-valuenow={Math.round(panelWidth)}
            aria-label={`Resize ${title} panel`}
            tabIndex={0}
            onKeyDown={handleResizeKeyDown}
            onPointerDown={handleResizePointerDown}
            onPointerMove={handleResizePointerMove}
            onPointerUp={handleResizePointerUp}
            onPointerCancel={handleResizePointerUp}
          />
        ) : null}
        <header className="talk-side-panel-header">
          <span className="talk-side-panel-icon" aria-hidden="true">
            <CTIcon name={icon} size={14} strokeWidth={1.7} />
          </span>
          <div className="talk-side-panel-heading">
            <h2>{title}</h2>
            {subtitle ? <p>{subtitle}</p> : null}
          </div>
          <button
            type="button"
            className="talk-side-panel-close"
            onClick={onClose}
            aria-label={`Close ${title}`}
            title={`Close ${title}`}
          >
            <CTIcon name="x" size={14} strokeWidth={1.8} />
          </button>
        </header>
        <div className="talk-side-panel-body ct-thin-scroll">{children}</div>
      </aside>
    </>
  );
}
