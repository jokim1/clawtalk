// Per-Talk timeline scroll position remembered across mounts.
//
// The Talk-show effect in TalkDetailPage uses this to decide whether to
// snap a freshly-mounted timeline to the bottom (default for "the user was
// last reading new messages") or restore the saved offset (the user had
// scrolled up to read history). The reducer no longer carries an
// `initialScrollPending` flag — this module owns first-paint scroll
// behavior end-to-end.

const KEY_PREFIX = 'clawtalk.scroll:';

export type TalkScrollState = {
  offset: number;
  atBottom: boolean;
};

function storage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function key(talkId: string): string {
  return `${KEY_PREFIX}${talkId}`;
}

function legacyKey(talkId: string): string {
  return `${KEY_PREFIX}${talkId}:${talkId}`;
}

function findLegacyValue(store: Storage, talkId: string): string | null {
  const prefix = `${KEY_PREFIX}${talkId}:`;
  for (let index = 0; index < store.length; index += 1) {
    const candidateKey = store.key(index);
    if (!candidateKey?.startsWith(prefix)) continue;
    return store.getItem(candidateKey);
  }
  return null;
}

function clearLegacyValues(store: Storage, talkId: string): void {
  const prefix = `${KEY_PREFIX}${talkId}:`;
  const keys: string[] = [];
  for (let index = 0; index < store.length; index += 1) {
    const candidateKey = store.key(index);
    if (candidateKey?.startsWith(prefix)) {
      keys.push(candidateKey);
    }
  }
  for (const candidateKey of keys) {
    store.removeItem(candidateKey);
  }
}

export function loadTalkScroll(talkId: string): TalkScrollState | null {
  const store = storage();
  if (!store) return null;
  const currentKey = key(talkId);
  const raw =
    store.getItem(currentKey) ??
    store.getItem(legacyKey(talkId)) ??
    findLegacyValue(store, talkId);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const offset = (parsed as { offset?: unknown }).offset;
    const atBottom = (parsed as { atBottom?: unknown }).atBottom;
    if (typeof offset !== 'number' || !Number.isFinite(offset)) return null;
    if (typeof atBottom !== 'boolean') return null;
    const state = { offset: Math.max(0, offset), atBottom };
    try {
      store.setItem(currentKey, JSON.stringify(state));
      clearLegacyValues(store, talkId);
    } catch {
      // Quota / private mode — best-effort migration only.
    }
    return state;
  } catch {
    return null;
  }
}

export function saveTalkScroll(talkId: string, state: TalkScrollState): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(key(talkId), JSON.stringify(state));
  } catch {
    // Quota / private mode — silently ignore.
  }
}

export function clearTalkScroll(talkId: string): void {
  const store = storage();
  if (!store) return;
  try {
    store.removeItem(key(talkId));
    clearLegacyValues(store, talkId);
  } catch {
    // ignore
  }
}
