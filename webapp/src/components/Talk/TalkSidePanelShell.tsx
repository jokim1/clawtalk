import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';

import { CTIcon, type CTIconName } from '../../salon';

export interface TalkSidePanelShellProps {
  title: string;
  subtitle?: string;
  icon: CTIconName;
  onClose: () => void;
  children: ReactNode;
}

export function TalkSidePanelShell({
  title,
  subtitle,
  icon,
  onClose,
  children,
}: TalkSidePanelShellProps): JSX.Element {
  const panelRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    onClose();
  };

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
