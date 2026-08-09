import { describe, expect, it } from 'vitest';

import { KEEP_ALIVE_KINDS, shouldKeepAliveTab, type TabPaneKind } from './keepAlive.js';

const ALL_KINDS: TabPaneKind[] = ['menu', 'list', 'card', 'chat', 'ai_chat', 'settings'];

describe('keepAlive: какие панели остаются смонтированными', () => {
  it('карточка не keep-alive ни на одной платформе — dirty-guard держит одну смонтированную', () => {
    expect(shouldKeepAliveTab('desktop', 'card')).toBe(false);
    expect(shouldKeepAliveTab('android', 'card')).toBe(false);
  });

  it('МЕНЮ и Настройки не keep-alive', () => {
    for (const kind of ['menu', 'settings'] as TabPaneKind[]) {
      expect(shouldKeepAliveTab('desktop', kind)).toBe(false);
      expect(shouldKeepAliveTab('android', kind)).toBe(false);
    }
  });

  it('список, Чат и ИИваныч keep-alive на десктопе', () => {
    for (const kind of ['list', 'chat', 'ai_chat'] as TabPaneKind[]) {
      expect(shouldKeepAliveTab('desktop', kind)).toBe(true);
    }
  });

  it('на Android keep-alive выключен для ВСЕХ видов (память WebView не замерена)', () => {
    for (const kind of ALL_KINDS) {
      expect(shouldKeepAliveTab('android', kind)).toBe(false);
    }
  });

  it('состав KEEP_ALIVE_KINDS зафиксирован', () => {
    expect([...KEEP_ALIVE_KINDS]).toEqual(['list', 'chat', 'ai_chat']);
  });
});
