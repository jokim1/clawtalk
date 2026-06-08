import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SignInView } from './SignInView';
import {
  completeDevCallback,
  getAuthConfig,
  startGoogleAuth,
} from '../lib/api';
import { signInWithGoogle } from '../lib/supabase-cookie-shim';

vi.mock('../lib/api', () => ({
  getAuthConfig: vi.fn(),
  startGoogleAuth: vi.fn(),
  completeDevCallback: vi.fn(),
}));

vi.mock('../lib/supabase-cookie-shim', () => ({
  signInWithGoogle: vi.fn(),
}));

function renderSignIn(onSignedIn = vi.fn()): void {
  render(
    <MemoryRouter initialEntries={['/app/talks/talk-123?view=full#latest']}>
      <SignInView onSignedIn={onSignedIn} />
    </MemoryRouter>,
  );
}

describe('SignInView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getAuthConfig).mockResolvedValue({ devMode: false });
    vi.mocked(startGoogleAuth).mockRejectedValue(
      new Error('stop after startGoogleAuth'),
    );
    vi.mocked(completeDevCallback).mockResolvedValue();
    vi.mocked(signInWithGoogle).mockResolvedValue();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('renders the ClawTalk brand heading', async () => {
    renderSignIn();

    expect(
      await screen.findByRole('heading', { name: 'ClawTalk' }),
    ).toBeTruthy();
  });

  it('hands off to supabase OAuth when the Google sign-in button is clicked', async () => {
    renderSignIn();

    const signInButton = await screen.findByRole('button', {
      name: 'Continue With Google',
    });
    fireEvent.click(signInButton);

    await waitFor(() => expect(signInWithGoogle).toHaveBeenCalled());
  });

  it('surfaces an error when the OAuth hand-off fails', async () => {
    vi.mocked(signInWithGoogle).mockRejectedValue(new Error('oauth boom'));
    renderSignIn();

    fireEvent.click(
      await screen.findByRole('button', { name: 'Continue With Google' }),
    );

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('oauth boom'),
    );
  });

  it('hides the dev quick-login form when dev mode is disabled', async () => {
    renderSignIn();

    // Wait for the config to settle (button is present immediately).
    await screen.findByRole('button', { name: 'Continue With Google' });
    expect(
      screen.queryByRole('heading', { name: 'Developer Quick Login' }),
    ).toBeNull();
  });

  it('completes the dev quick-login flow when dev mode is enabled', async () => {
    vi.mocked(getAuthConfig).mockResolvedValue({ devMode: true });
    vi.mocked(startGoogleAuth).mockResolvedValue({
      state: 'state-x',
      authorizationUrl: 'https://auth.example/callback',
      expiresInSec: 600,
    });
    const onSignedIn = vi.fn();
    renderSignIn(onSignedIn);

    await screen.findByRole('heading', { name: 'Developer Quick Login' });
    fireEvent.click(screen.getByRole('button', { name: 'Dev Login' }));

    await waitFor(() => expect(completeDevCallback).toHaveBeenCalled());
    await waitFor(() => expect(onSignedIn).toHaveBeenCalled());
  });
});
