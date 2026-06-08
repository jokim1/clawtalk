import { useEffect, useRef, useState } from 'react';

import {
  ApiError,
  completeAnthropicSubscriptionOauth,
  initiateAnthropicSubscriptionOauth,
  initiateOpenAiCodexSubscriptionOauth,
  pollOpenAiCodexSubscriptionOauth,
  type ProviderCredentialScope,
  UnauthorizedError,
} from '../../lib/api';
import {
  type AnthropicSubscriptionOauthState,
  draftKey,
  emptyAnthropicSubscriptionOauthState,
  emptyOpenAiCodexSubscriptionOauthState,
  type OpenAiCodexSubscriptionOauthState,
} from './ProviderConfigPanel';

export const settingsPageNavigation = {
  reload: (): void => {
    window.location.reload();
  },
};

type UseProviderSubscriptionOauthInput = {
  onUnauthorized: () => void;
  workspaceId?: string | null;
};

type UseProviderSubscriptionOauthResult = {
  anthropicOauth: Record<string, AnthropicSubscriptionOauthState>;
  openAiCodexOauth: Record<string, OpenAiCodexSubscriptionOauthState>;
  startAnthropicSubscription: (
    scope: ProviderCredentialScope,
    providerId: string,
  ) => Promise<void>;
  completeAnthropicSubscription: (
    scope: ProviderCredentialScope,
    providerId: string,
  ) => Promise<void>;
  cancelAnthropicSubscription: (
    scope: ProviderCredentialScope,
    providerId: string,
  ) => void;
  updateAnthropicCodeDraft: (
    scope: ProviderCredentialScope,
    providerId: string,
    codeDraft: string,
  ) => void;
  startOpenAiCodexSubscription: (
    scope: ProviderCredentialScope,
    providerId: string,
  ) => Promise<void>;
  cancelOpenAiCodexSubscription: (
    scope: ProviderCredentialScope,
    providerId: string,
  ) => void;
};

function updateOauthRecord<T>(
  current: Record<string, T>,
  key: string,
  initial: () => T,
  patch: Partial<T>,
): Record<string, T> {
  return {
    ...current,
    [key]: {
      ...initial(),
      ...(current[key] || {}),
      ...patch,
    },
  };
}

export function useProviderSubscriptionOauth({
  onUnauthorized,
  workspaceId,
}: UseProviderSubscriptionOauthInput): UseProviderSubscriptionOauthResult {
  const [anthropicOauth, setAnthropicOauth] = useState<
    Record<string, AnthropicSubscriptionOauthState>
  >({});
  const [openAiCodexOauth, setOpenAiCodexOauth] = useState<
    Record<string, OpenAiCodexSubscriptionOauthState>
  >({});
  const onUnauthorizedRef = useRef(onUnauthorized);

  useEffect(() => {
    onUnauthorizedRef.current = onUnauthorized;
  }, [onUnauthorized]);

  const updateAnthropicOauth = (
    scope: ProviderCredentialScope,
    providerId: string,
    patch: Partial<AnthropicSubscriptionOauthState>,
  ): void => {
    setAnthropicOauth((current) =>
      updateOauthRecord(
        current,
        draftKey(scope, providerId),
        emptyAnthropicSubscriptionOauthState,
        patch,
      ),
    );
  };

  const updateOpenAiCodexOauth = (
    scope: ProviderCredentialScope,
    providerId: string,
    patch: Partial<OpenAiCodexSubscriptionOauthState>,
  ): void => {
    setOpenAiCodexOauth((current) =>
      updateOauthRecord(
        current,
        draftKey(scope, providerId),
        emptyOpenAiCodexSubscriptionOauthState,
        patch,
      ),
    );
  };

  const cancelAnthropicSubscription = (
    scope: ProviderCredentialScope,
    providerId: string,
  ): void => {
    setAnthropicOauth((current) =>
      updateOauthRecord(
        current,
        draftKey(scope, providerId),
        emptyAnthropicSubscriptionOauthState,
        emptyAnthropicSubscriptionOauthState(),
      ),
    );
  };

  const cancelOpenAiCodexSubscription = (
    scope: ProviderCredentialScope,
    providerId: string,
  ): void => {
    setOpenAiCodexOauth((current) =>
      updateOauthRecord(
        current,
        draftKey(scope, providerId),
        emptyOpenAiCodexSubscriptionOauthState,
        emptyOpenAiCodexSubscriptionOauthState(),
      ),
    );
  };

  useEffect(() => {
    let cancelled = false;
    const timers: number[] = [];

    const setOpenAiOauthByKey = (
      key: string,
      patch: Partial<OpenAiCodexSubscriptionOauthState>,
    ): void => {
      setOpenAiCodexOauth((current) =>
        updateOauthRecord(
          current,
          key,
          emptyOpenAiCodexSubscriptionOauthState,
          patch,
        ),
      );
    };

    for (const [key, oauth] of Object.entries(openAiCodexOauth)) {
      const pending = oauth.pending;
      if (!pending || !oauth.polling) continue;

      const scheduleTick = (): void => {
        const timer = window.setTimeout(() => {
          void tick();
        }, pending.pollIntervalSeconds * 1000);
        timers.push(timer);
      };

      const tick = async (): Promise<void> => {
        try {
          const result = await pollOpenAiCodexSubscriptionOauth({
            state: pending.state,
          });
          if (cancelled) return;
          if (result.status === 'authorized') {
            setOpenAiOauthByKey(key, { pending: null, polling: false });
            settingsPageNavigation.reload();
            return;
          }
          scheduleTick();
        } catch (err) {
          if (cancelled) return;
          if (err instanceof UnauthorizedError) {
            onUnauthorizedRef.current();
            return;
          }
          setOpenAiOauthByKey(key, {
            error:
              err instanceof ApiError
                ? err.message
                : 'Failed to poll OpenAI device authorization.',
            polling: false,
          });
        }
      };

      scheduleTick();
    }

    return () => {
      cancelled = true;
      for (const timer of timers) clearTimeout(timer);
    };
  }, [openAiCodexOauth]);

  const startAnthropicSubscription = async (
    scope: ProviderCredentialScope,
    providerId: string,
  ): Promise<void> => {
    updateAnthropicOauth(scope, providerId, {
      busy: true,
      error: null,
      done: false,
    });
    try {
      const init = await initiateAnthropicSubscriptionOauth(scope, {
        workspaceId,
      });
      updateAnthropicOauth(scope, providerId, {
        authorizeUrl: init.authorizationUrl,
        state: init.state,
        error: null,
      });
      window.open(init.authorizationUrl, '_blank', 'noopener,noreferrer');
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      updateAnthropicOauth(scope, providerId, {
        error:
          err instanceof ApiError
            ? err.message
            : 'Failed to start Claude OAuth.',
      });
    } finally {
      updateAnthropicOauth(scope, providerId, { busy: false });
    }
  };

  const completeAnthropicSubscription = async (
    scope: ProviderCredentialScope,
    providerId: string,
  ): Promise<void> => {
    const oauth =
      anthropicOauth[draftKey(scope, providerId)] ||
      emptyAnthropicSubscriptionOauthState();
    if (!oauth.state || !oauth.codeDraft.trim()) {
      updateAnthropicOauth(scope, providerId, {
        error: 'Paste the code from console.anthropic.com.',
      });
      return;
    }
    updateAnthropicOauth(scope, providerId, { busy: true, error: null });
    try {
      const codeOnly = oauth.codeDraft.trim().split('#')[0];
      await completeAnthropicSubscriptionOauth({
        state: oauth.state,
        code: codeOnly,
      });
      updateAnthropicOauth(scope, providerId, { done: true });
      settingsPageNavigation.reload();
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      updateAnthropicOauth(scope, providerId, {
        error:
          err instanceof ApiError
            ? err.message
            : 'Failed to complete Claude OAuth.',
      });
    } finally {
      updateAnthropicOauth(scope, providerId, { busy: false });
    }
  };

  const updateAnthropicCodeDraft = (
    scope: ProviderCredentialScope,
    providerId: string,
    codeDraft: string,
  ): void => {
    updateAnthropicOauth(scope, providerId, { codeDraft });
  };

  const startOpenAiCodexSubscription = async (
    scope: ProviderCredentialScope,
    providerId: string,
  ): Promise<void> => {
    updateOpenAiCodexOauth(scope, providerId, {
      busy: true,
      error: null,
      polling: false,
    });
    try {
      const init = await initiateOpenAiCodexSubscriptionOauth(scope, {
        workspaceId,
      });
      updateOpenAiCodexOauth(scope, providerId, {
        pending: {
          state: init.state,
          userCode: init.userCode,
          verificationUrl: init.verificationUrl,
          pollIntervalSeconds: init.pollIntervalSeconds,
        },
        busy: false,
        error: null,
        polling: true,
      });
      window.open(init.verificationUrl, '_blank', 'noopener,noreferrer');
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        updateOpenAiCodexOauth(scope, providerId, { busy: false });
        onUnauthorized();
        return;
      }
      updateOpenAiCodexOauth(scope, providerId, {
        error:
          err instanceof ApiError
            ? err.message
            : 'Failed to start ChatGPT OAuth.',
        busy: false,
      });
    }
  };

  return {
    anthropicOauth,
    openAiCodexOauth,
    startAnthropicSubscription,
    completeAnthropicSubscription,
    cancelAnthropicSubscription,
    updateAnthropicCodeDraft,
    startOpenAiCodexSubscription,
    cancelOpenAiCodexSubscription,
  };
}
