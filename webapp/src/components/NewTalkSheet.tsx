/**
 * NewTalkSheet — Salon-native "name it before you start" dialog for creating a
 * Talk. Replaces the old instant untitled-talk creation (App.handleCreateTalk).
 * Built on the Salon `Sheet` primitive, which was itself ported from the
 * prototype's `NewTalkSheet` (see salon/Sheet.tsx).
 *
 * Presentational: the parent owns open-state, the create+navigate side effect,
 * and focus restoration (captured at open-time, before this mounts). This sheet
 * only collects a title and reports submit/cancel. On a rejected `onCreate` it
 * surfaces the error and stays open; on resolve the parent closes it.
 */
import { useEffect, useRef, useState } from 'react';
import { Sheet } from '../salon/Sheet';
import { Button } from '../salon/Button';
import { Input } from '../salon/Input';
import { Kbd } from '../salon/Kbd';
import { salon, salonFont } from '../salon/tokens';

export interface NewTalkSheetProps {
  /**
   * Called with the trimmed title on submit. Reject to surface an error and
   * keep the sheet open; resolve and the parent closes it (and navigates).
   */
  onCreate: (title: string) => Promise<void>;
  /** Cancel / Escape / backdrop dismissal (ignored while a create is in flight). */
  onClose: () => void;
}

export function NewTalkSheet({ onCreate, onClose }: NewTalkSheetProps): JSX.Element {
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  // Synchronous guard against a double-submit firing within one tick (Enter +
  // click) before the disabled state flushes. State alone can race.
  const submittingRef = useRef(false);

  // Initial focus. The sheet mounts only when open, so seed focus into the
  // title field once on mount — Modal/Sheet don't trap or seed focus.
  useEffect(() => {
    formRef.current?.querySelector('input')?.focus();
  }, []);

  const submit = async (): Promise<void> => {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await onCreate(title.trim());
      // Parent closes the sheet on success (it also navigates to the new Talk).
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the Talk.');
      setBusy(false);
      submittingRef.current = false;
    }
  };

  return (
    <Sheet
      title="New Talk"
      width={520}
      // Always dismissable (Escape / backdrop / Cancel) so a stalled create
      // can never trap the user — fetch has no timeout. Only the primary
      // action is locked mid-flight to prevent a duplicate create; an in-flight
      // create that resolves after dismissal still completes and navigates.
      onClose={onClose}
      headerAccessory={<Kbd>Esc</Kbd>}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void submit()} disabled={busy}>
            {busy ? 'Creating…' : 'Create Talk'}
          </Button>
        </>
      }
    >
      <form
        ref={formRef}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <label
          htmlFor="new-talk-title"
          style={{
            display: 'block',
            marginBottom: 6,
            fontFamily: salonFont.sans,
            fontSize: 12,
            fontWeight: 500,
            color: salon.ink2,
          }}
        >
          Title
        </label>
        <Input
          id="new-talk-title"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              void submit();
            }
          }}
          placeholder="Untitled talk"
          disabled={busy}
          autoComplete="off"
        />
        <p
          style={{
            margin: '10px 0 0',
            fontFamily: salonFont.sans,
            fontSize: 12,
            color: salon.ink2,
          }}
        >
          Give your Talk a name, or leave it blank to start untitled.
        </p>
        {error ? (
          <p
            role="alert"
            style={{
              margin: '10px 0 0',
              fontFamily: salonFont.sans,
              fontSize: 13,
              // Danger ink — matches Button "danger" + RUN_STATES.failed.fg.
              color: '#7b2a30',
            }}
          >
            {error}
          </p>
        ) : null}
      </form>
    </Sheet>
  );
}
