/**
 * SignInView — Salon-native pre-auth surface. Full-page centered card with the
 * ClawTalk mark, the Google OAuth hand-off, an optional dev quick-login form
 * (dev mode only), and an inline error. Rendered standalone before the app
 * shell mounts (App.tsx), so it owns its own paper background + centering.
 */
import { FormEvent, useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';

import { Button, CTMark, Input, salon, salonFont } from '../salon';
import {
  completeDevCallback,
  getAuthConfig,
  startGoogleAuth,
} from '../lib/api';
import { signInWithGoogle } from '../lib/supabase-cookie-shim';

export function SignInView(props: {
  onSignedIn: () => Promise<void> | void;
}): JSX.Element {
  const location = useLocation();
  const [email, setEmail] = useState('owner@example.com');
  const [name, setName] = useState('Owner');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showDevLogin, setShowDevLogin] = useState(false);
  const returnTo = `${location.pathname}${location.search}${location.hash}`;

  useEffect(() => {
    let cancelled = false;

    const loadConfig = async () => {
      try {
        const config = await getAuthConfig();
        if (!cancelled) setShowDevLogin(config.devMode);
      } catch {
        if (!cancelled) setShowDevLogin(false);
      }
    };

    void loadConfig();
    return () => {
      cancelled = true;
    };
  }, []);

  const signInWithRedirect = async () => {
    setBusy(true);
    setError(null);
    try {
      await signInWithGoogle();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to start sign-in');
      setBusy(false);
    }
  };

  const completeDevLogin = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const auth = await startGoogleAuth({ returnTo });
      const callback = new URL(auth.authorizationUrl, window.location.origin);
      callback.searchParams.set('email', email.trim());
      callback.searchParams.set('name', name.trim() || 'User');
      await completeDevCallback(callback.toString());
      await props.onSignedIn();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to sign in');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main
      className="ct-screen-enter"
      style={{
        minHeight: '100vh',
        display: 'grid',
        placeItems: 'center',
        padding: 16,
        background: 'var(--salon-paper, #fbf7ef)',
      }}
    >
      <section
        style={{
          width: 'min(420px, 100%)',
          background: 'var(--salon-card, #ffffff)',
          border: `1px solid ${salon.line}`,
          borderRadius: 16,
          padding: 24,
          boxShadow: '0 10px 30px rgba(31, 27, 22, 0.06)',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            marginBottom: 6,
          }}
        >
          <CTMark size={32} />
          <h1
            style={{
              margin: 0,
              fontFamily: salonFont.display,
              fontSize: 30,
              fontWeight: 400,
              color: salon.ink,
            }}
          >
            ClawTalk
          </h1>
        </div>
        <p
          style={{
            margin: '0 0 18px',
            fontSize: 13.5,
            color: salon.ink2,
            lineHeight: 1.5,
          }}
        >
          Sign in to access your talks and machine-local context.
        </p>

        <Button
          variant="primary"
          onClick={signInWithRedirect}
          disabled={busy}
          style={{ width: '100%' }}
        >
          Continue With Google
        </Button>

        {showDevLogin ? (
          <form
            onSubmit={completeDevLogin}
            style={{
              marginTop: 18,
              borderTop: `1px solid ${salon.line}`,
              paddingTop: 16,
              display: 'flex',
              flexDirection: 'column',
              gap: 12,
            }}
          >
            <h2
              style={{
                margin: 0,
                fontFamily: salonFont.serif,
                fontSize: 15,
                fontWeight: 500,
                color: salon.ink,
              }}
            >
              Developer Quick Login
            </h2>
            <label
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 4,
                fontSize: 12.5,
                color: salon.ink2,
              }}
            >
              Email
              <Input
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                type="email"
                required
              />
            </label>
            <label
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 4,
                fontSize: 12.5,
                color: salon.ink2,
              }}
            >
              Display Name
              <Input
                value={name}
                onChange={(event) => setName(event.target.value)}
                type="text"
                required
              />
            </label>
            <Button
              type="submit"
              variant="secondary"
              disabled={busy}
              style={{ width: 'fit-content' }}
            >
              Dev Login
            </Button>
          </form>
        ) : null}

        {error ? (
          <div
            role="alert"
            style={{
              marginTop: 16,
              padding: '10px 14px',
              borderRadius: 12,
              background: '#fbecec',
              color: '#7b2a30',
              fontSize: 13,
            }}
          >
            {error}
          </div>
        ) : null}
      </section>
    </main>
  );
}
