import { describe, expect, it } from 'vitest';

import { consumeIssuedPath, rememberIssuedPath } from './pathOriginRegistry.js';

const isWin = process.platform === 'win32';
const p1 = isWin ? 'C:\\tmp\\pick-one.png' : '/tmp/pick-one.png';

describe('pathOriginRegistry (security-hardening-2026-06 Phase 3)', () => {
  it('rejects a path that was never issued (forged renderer path)', () => {
    expect(consumeIssuedPath(isWin ? 'C:\\Windows\\System32\\config\\SAM' : '/etc/shadow')).toBe(false);
  });

  it('accepts a path after it was issued, and keeps accepting (no delete-on-consume)', () => {
    rememberIssuedPath(p1);
    expect(consumeIssuedPath(p1)).toBe(true);
    // same picked file may be sent to several recipients / scopes
    expect(consumeIssuedPath(p1)).toBe(true);
  });

  it('normalizes equivalent paths (. / .. segments)', () => {
    const messy = isWin ? 'C:\\tmp\\sub\\..\\pick-two.png' : '/tmp/sub/../pick-two.png';
    const clean = isWin ? 'C:\\tmp\\pick-two.png' : '/tmp/pick-two.png';
    rememberIssuedPath(messy);
    expect(consumeIssuedPath(clean)).toBe(true);
  });

  it('treats Windows paths case-insensitively', () => {
    if (!isWin) return;
    rememberIssuedPath('C:\\Tmp\\Pick-Three.PNG');
    expect(consumeIssuedPath('c:\\tmp\\pick-three.png')).toBe(true);
  });

  it('rejects empty paths', () => {
    expect(consumeIssuedPath('')).toBe(false);
    rememberIssuedPath('');
    expect(consumeIssuedPath('')).toBe(false);
  });
});
