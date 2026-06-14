const KEY_PREFIX = 'clawtalk.sidePanelWidth:';

export const SIDE_PANEL_WIDTH_DEFAULT = 400;
export const SIDE_PANEL_WIDTH_MIN = 320;
export const SIDE_PANEL_WIDTH_MAX = 640;

function getStorage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function clampSidePanelWidth(
  value: number,
  maxWidth = SIDE_PANEL_WIDTH_MAX,
): number {
  const effectiveMax = Math.max(
    SIDE_PANEL_WIDTH_MIN,
    Math.min(SIDE_PANEL_WIDTH_MAX, maxWidth),
  );
  if (!Number.isFinite(value)) {
    return Math.max(
      SIDE_PANEL_WIDTH_MIN,
      Math.min(SIDE_PANEL_WIDTH_DEFAULT, effectiveMax),
    );
  }
  if (value < SIDE_PANEL_WIDTH_MIN) return SIDE_PANEL_WIDTH_MIN;
  if (value > effectiveMax) return effectiveMax;
  return value;
}

export function getSidePanelWidth(panelKey: string): number {
  const storage = getStorage();
  if (!storage) return SIDE_PANEL_WIDTH_DEFAULT;
  const stored = storage.getItem(KEY_PREFIX + panelKey);
  if (stored === null) return SIDE_PANEL_WIDTH_DEFAULT;
  const parsed = Number.parseFloat(stored);
  return Number.isFinite(parsed)
    ? clampSidePanelWidth(parsed)
    : SIDE_PANEL_WIDTH_DEFAULT;
}

export function setSidePanelWidth(panelKey: string, width: number): void {
  const storage = getStorage();
  if (!storage) return;
  storage.setItem(
    KEY_PREFIX + panelKey,
    String(clampSidePanelWidth(width)),
  );
}
