/**
 * CommandPalette — ⌘K / Ctrl+K quick switcher. Built on the Salon `Modal`
 * primitive with a combobox/listbox a11y pattern: DOM focus stays in the search
 * input while ArrowUp/Down move `aria-activedescendant`, so there's no focus
 * trap and Enter always runs the highlighted command.
 *
 * Presentational: the parent (App) builds the `items` (navigation targets, the
 * New Talk action, and the user's Talks from the in-memory sidebar) and owns
 * open-state + focus restoration. Each item's `run` performs its side effect;
 * the palette closes itself afterwards.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Modal } from '../salon/Modal';
import { Kbd } from '../salon/Kbd';
import { salon, salonFont } from '../salon/tokens';

export interface CommandItem {
  id: string;
  label: string;
  /** Right-aligned category hint, e.g. "Go to", "Talk", "Action". */
  hint?: string;
  /** Extra text folded into the match (not displayed). */
  keywords?: string;
  run: () => void;
}

export interface CommandPaletteProps {
  items: CommandItem[];
  onClose: () => void;
}

function matches(item: CommandItem, query: string): boolean {
  if (!query) return true;
  const haystack =
    `${item.label} ${item.hint ?? ''} ${item.keywords ?? ''}`.toLowerCase();
  // Every whitespace-separated token must appear (order-independent).
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((token) => haystack.includes(token));
}

export function CommandPalette({
  items,
  onClose,
}: CommandPaletteProps): JSX.Element {
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const activeRef = useRef<HTMLLIElement>(null);

  const filtered = useMemo(
    () => items.filter((item) => matches(item, query)),
    [items, query],
  );

  // Keep the highlighted row valid as the filter narrows, and seed focus.
  useEffect(() => {
    setActiveIndex(0);
  }, [query]);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  const runAt = (index: number): void => {
    const item = filtered[index];
    if (!item) return;
    item.run();
    onClose();
  };

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((i) => (filtered.length ? (i + 1) % filtered.length : 0));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((i) =>
        filtered.length ? (i - 1 + filtered.length) % filtered.length : 0,
      );
    } else if (event.key === 'Enter') {
      event.preventDefault();
      runAt(activeIndex);
    }
    // Escape is handled by Modal (calls onClose).
  };

  const activeId = filtered[activeIndex]
    ? `${listId}-opt-${activeIndex}`
    : undefined;

  return (
    <Modal onClose={onClose} width={560} ariaLabel="Command palette">
      <div
        style={{
          padding: '12px 14px',
          borderBottom: `1px solid ${salon.line}`,
        }}
      >
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={activeId}
          aria-label="Search commands and Talks"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Search commands and Talks…"
          autoComplete="off"
          className="salon-field"
          style={{
            width: '100%',
            height: 40,
            padding: '0 12px',
            borderRadius: 10,
            fontSize: 15,
            color: salon.ink,
            fontFamily: salonFont.sans,
            outline: 'none',
          }}
        />
      </div>
      <ul
        id={listId}
        role="listbox"
        aria-label="Commands and Talks"
        style={{
          listStyle: 'none',
          margin: 0,
          padding: 6,
          maxHeight: 360,
          overflowY: 'auto',
        }}
      >
        {filtered.length === 0 ? (
          // Not an option: it's a status message, not a selectable row, so
          // screen readers shouldn't announce it as an activatable listbox item.
          <li
            role="presentation"
            style={{
              padding: '14px 12px',
              color: salon.ink2,
              fontFamily: salonFont.sans,
              fontSize: 14,
            }}
          >
            <span role="status">No matches.</span>
          </li>
        ) : (
          filtered.map((item, index) => {
            const active = index === activeIndex;
            return (
              <li
                key={item.id}
                id={`${listId}-opt-${index}`}
                ref={active ? activeRef : undefined}
                role="option"
                aria-selected={active}
                onMouseMove={() => setActiveIndex(index)}
                onClick={() => runAt(index)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 12,
                  padding: '9px 12px',
                  borderRadius: 8,
                  cursor: 'pointer',
                  background: active ? salon.paper2 : 'transparent',
                  color: salon.ink,
                  fontFamily: salonFont.sans,
                  fontSize: 14,
                }}
              >
                <span
                  style={{
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {item.label}
                </span>
                {item.hint ? (
                  <span
                    style={{ flexShrink: 0, color: salon.ink2, fontSize: 12 }}
                  >
                    {item.hint}
                  </span>
                ) : null}
              </li>
            );
          })
        )}
      </ul>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '8px 14px',
          borderTop: `1px solid ${salon.line}`,
          background: salon.paper,
          color: salon.ink2,
          fontFamily: salonFont.sans,
          fontSize: 11,
        }}
      >
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd>
          to navigate
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <Kbd>↵</Kbd>
          to open
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <Kbd>Esc</Kbd>
          to dismiss
        </span>
      </div>
    </Modal>
  );
}
