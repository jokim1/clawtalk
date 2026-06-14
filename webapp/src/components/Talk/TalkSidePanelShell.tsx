import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from 'react';

import { CTIcon, type CTIconName } from '../../salon';
import {
  clampSidePanelWidth,
  getSidePanelWidth,
  SIDE_PANEL_WIDTH_MAX,
  SIDE_PANEL_WIDTH_MIN,
  setSidePanelWidth,
} from '../../lib/sidePanelWidth';

export interface TalkSidePanelShellProps {
  title: string;
  subtitle?: string;
  icon: CTIconName;
  resizeStorageKey: string;
  onClose: () => void;
  children: ReactNode;
}

const RESIZE_KEYBOARD_STEP = 24;
const MIN_MAIN_PANE_WIDTH = 360;

export function TalkSidePanelShell({
  title,
  subtitle,
  icon,
  resizeStorageKey,
  onClose,
  children,
}: TalkSidePanelShellProps): JSX.Element {
  const panelRef = useRef<HTMLElement | null>(null);
  const resizeHandleRef = useRef<HTMLDivElement | null>(null);
  const resizingRef = useRef(false);
  const [panelWidth, setPanelWidth] = useState(() =>
    getSidePanelWidth(resizeStorageKey),
  );

  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  useEffect(() => {
    setPanelWidth(getSidePanelWidth(resizeStorageKey));
  }, [resizeStorageKey]);

  const getMaxWidth = useCallback((): number => {
    const parent = panelRef.current?.parentElement;
    const parentRect = parent?.getBoundingClientRect();
    const parentWidth = parentRect?.width ?? 0;
    if (parentWidth <= 0) return SIDE_PANEL_WIDTH_MAX;
    return Math.max(
      SIDE_PANEL_WIDTH_MIN,
      Math.min(SIDE_PANEL_WIDTH_MAX, parentWidth - MIN_MAIN_PANE_WIDTH),
    );
  }, []);

  const applyPanelWidth = useCallback(
    (nextRaw: number) => {
      const next = clampSidePanelWidth(nextRaw, getMaxWidth());
      setPanelWidth(next);
      setSidePanelWidth(resizeStorageKey, next);
    },
    [getMaxWidth, resizeStorageKey],
  );

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    onClose();
  };

  const handleResizeKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        applyPanelWidth(panelWidth + RESIZE_KEYBOARD_STEP);
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        applyPanelWidth(panelWidth - RESIZE_KEYBOARD_STEP);
      } else if (event.key === 'Home') {
        event.preventDefault();
        applyPanelWidth(SIDE_PANEL_WIDTH_MIN);
      } else if (event.key === 'End') {
        event.preventDefault();
        applyPanelWidth(getMaxWidth());
      }
    },
    [applyPanelWidth, getMaxWidth, panelWidth],
  );

  useEffect(() => {
    const handle = resizeHandleRef.current;
    if (!handle) return;
    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      resizingRef.current = true;
      event.preventDefault();
      handle.setPointerCapture?.(event.pointerId);
    };
    const onPointerMove = (event: PointerEvent) => {
      if (!resizingRef.current) return;
      const panel = panelRef.current;
      if (!panel) return;
      const rect = panel.getBoundingClientRect();
      applyPanelWidth(rect.right - event.clientX);
    };
    const onPointerUp = (event: PointerEvent) => {
      resizingRef.current = false;
      if (handle.hasPointerCapture?.(event.pointerId)) {
        handle.releasePointerCapture?.(event.pointerId);
      }
    };
    handle.addEventListener('pointerdown', onPointerDown);
    handle.addEventListener('pointermove', onPointerMove);
    handle.addEventListener('pointerup', onPointerUp);
    handle.addEventListener('pointercancel', onPointerUp);
    return () => {
      handle.removeEventListener('pointerdown', onPointerDown);
      handle.removeEventListener('pointermove', onPointerMove);
      handle.removeEventListener('pointerup', onPointerUp);
      handle.removeEventListener('pointercancel', onPointerUp);
    };
  }, [applyPanelWidth]);

  const panelStyle = useMemo(
    () =>
      ({
        '--talk-side-panel-width': `${panelWidth}px`,
      }) as CSSProperties,
    [panelWidth],
  );

  return (
    <>
      <button
        type="button"
        className="talk-side-panel-backdrop"
        onClick={onClose}
        aria-hidden="true"
        tabIndex={-1}
      />
      <div
        ref={resizeHandleRef}
        className="talk-side-panel-resize-handle"
        role="separator"
        aria-orientation="vertical"
        aria-valuemin={SIDE_PANEL_WIDTH_MIN}
        aria-valuemax={SIDE_PANEL_WIDTH_MAX}
        aria-valuenow={Math.round(panelWidth)}
        aria-label={`Resize ${title} panel`}
        tabIndex={0}
        title={`Resize ${title} panel`}
        onKeyDown={handleResizeKeyDown}
      />
      <aside
        ref={panelRef}
        className="talk-side-panel ct-screen-enter"
        aria-label={title}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
        style={panelStyle}
      >
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
