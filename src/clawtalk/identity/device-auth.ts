export interface DeviceAuthStartResult {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresInSec: number;
  intervalSec: number;
}

export interface DeviceAuthCompleteResult {
  accessToken: string;
  refreshToken: string;
  expiresInSec: number;
}

// Phase 0 placeholder. Full OAuth/device flow arrives in Phase 1.
export function startDeviceAuth(): DeviceAuthStartResult {
  return {
    deviceCode: 'phase0-device-code',
    userCode: 'PHASE0',
    verificationUri: 'https://example.invalid/device',
    expiresInSec: 600,
    intervalSec: 5,
  };
}

// Phase 0 placeholder. Full OAuth/device flow arrives in Phase 1.
export function completeDeviceAuth(): DeviceAuthCompleteResult {
  return {
    accessToken: 'phase0-access-token',
    refreshToken: 'phase0-refresh-token',
    expiresInSec: 3600,
  };
}
