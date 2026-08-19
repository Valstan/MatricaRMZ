import { beforeEach, describe, expect, it, vi } from 'vitest';

// Раскладки колонок: user-scope ключа (общая рабочая станция), перенос легаси-
// записи, LWW-гидрация серверных копий.

const store = new Map<string, string>();
const listeners: Array<(ev: Event) => void> = [];

vi.stubGlobal('window', {
  localStorage: {
    get length() {
      return store.size;
    },
    key: (i: number) => [...store.keys()][i] ?? null,
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  },
  dispatchEvent: (ev: Event) => {
    for (const l of listeners) l(ev);
    return true;
  },
  addEventListener: (_t: string, l: (ev: Event) => void) => listeners.push(l),
  removeEventListener: () => {},
  CustomEvent: class {
    type: string;
    detail: unknown;
    constructor(type: string, init?: { detail?: unknown }) {
      this.type = type;
      this.detail = init?.detail;
    }
  },
});
// CustomEvent конструируется напрямую в модуле.
vi.stubGlobal('CustomEvent', (window as unknown as { CustomEvent: unknown }).CustomEvent);

const {
  clearColumnLayout,
  hydrateColumnLayouts,
  readAllColumnLayouts,
  readColumnLayout,
  setColumnLayoutUser,
  writeColumnLayout,
} = await import('./columnLayoutStore.js');

const U1 = 'user-1';
const U2 = 'user-2';

beforeEach(() => {
  store.clear();
  listeners.length = 0;
  setColumnLayoutUser(U1);
});

describe('columnLayoutStore', () => {
  it('scopes keys per user — one operator does not see another layout', () => {
    writeColumnLayout('list:engines:columns', { order: ['a', 'b'], hidden: ['b'] });
    setColumnLayoutUser(U2);
    expect(readColumnLayout('list:engines:columns')).toBeNull();
    setColumnLayoutUser(U1);
    expect(readColumnLayout('list:engines:columns')?.order).toEqual(['a', 'b']);
  });

  it('migrates a legacy unscoped entry into the current user scope', () => {
    store.set('matrica:columnLayout:list:engines:columns', JSON.stringify({ order: ['x'], hidden: [] }));
    const read = readColumnLayout('list:engines:columns');
    expect(read?.order).toEqual(['x']);
    // Легаси-запись без штампа: серверная копия любой свежести побеждает.
    expect(read?.updatedAt).toBe(0);
    expect(store.has(`matrica:columnLayout:${U1}:list:engines:columns`)).toBe(true);
  });

  it('readAllColumnLayouts returns only the current user layouts', () => {
    writeColumnLayout('list:a', { order: ['1'], hidden: [] });
    setColumnLayoutUser(U2);
    writeColumnLayout('list:b', { order: ['2'], hidden: [] });
    expect(Object.keys(readAllColumnLayouts())).toEqual(['list:b']);
    setColumnLayoutUser(U1);
    expect(Object.keys(readAllColumnLayouts())).toEqual(['list:a']);
  });

  it('hydrate applies a fresher server copy and keeps a fresher local one', () => {
    writeColumnLayout('list:a', { order: ['local'], hidden: [] }, { updatedAt: 2000 });
    writeColumnLayout('list:b', { order: ['local'], hidden: [] }, { updatedAt: 1000 });
    const applied = hydrateColumnLayouts({
      'list:a': { order: ['server'], hidden: [], updatedAt: 1500 },
      'list:b': { order: ['server'], hidden: [], updatedAt: 3000 },
      'list:c': { order: ['server'], hidden: ['x'], updatedAt: 500 },
    });
    expect(applied).toBe(2); // b обновлён, c создан; a остался локальным
    expect(readColumnLayout('list:a')?.order).toEqual(['local']);
    expect(readColumnLayout('list:b')?.order).toEqual(['server']);
    expect(readColumnLayout('list:c')?.hidden).toEqual(['x']);
  });

  it('reset removes the layout locally without touching other layouts', () => {
    writeColumnLayout('list:a', { order: ['1'], hidden: [] });
    writeColumnLayout('list:b', { order: ['2'], hidden: [] });
    clearColumnLayout('list:a');
    expect(readColumnLayout('list:a')).toBeNull();
    expect(readColumnLayout('list:b')?.order).toEqual(['2']);
  });
});
