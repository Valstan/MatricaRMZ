import { describe, expect, it } from 'vitest';

import { isOfflineSyncError } from './syncErrorClassifier.js';

describe('syncErrorClassifier', () => {
  it('detects plain offline error values', () => {
    expect(isOfflineSyncError('offline')).toBe(true);
    expect(isOfflineSyncError(new Error('offline'))).toBe(true);
  });

  it('detects stack-formatted offline errors', () => {
    const err = new Error('offline');
    err.stack = 'Error: offline\n    at fetchWithRetry (...)';
    expect(isOfflineSyncError(err)).toBe(true);
  });

  it('does not classify non-offline errors as offline', () => {
    expect(isOfflineSyncError(new Error('timeout'))).toBe(false);
    expect(isOfflineSyncError('auth required')).toBe(false);
  });
});

