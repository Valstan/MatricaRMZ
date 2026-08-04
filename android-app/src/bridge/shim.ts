// F0 spike bridge: enough of window.matrica for the renderer to boot to the
// login screen outside Electron. Real implementations arrive in F1
// (docs/plans/android-tablet-client-2026-08.md).
//
// Contract discovery is the point of the spike, so unknown METHOD access on a
// known group loudly logs and returns { ok: false } instead of crashing —
// EXCEPT `on*` subscription props, which must stay undefined so the
// renderer's existence guards (sync.onProgress, app.onCloseRequest, …)
// fail closed instead of receiving a non-function.

const missed = new Set<string>();

function reportMiss(group: string, method: string): void {
  const key = `${group}.${method}`;
  if (missed.has(key)) return;
  missed.add(key);
  console.warn(`[matrica-shim] not implemented: ${key}`);
}

function stubGroup(group: string, impl: Record<string, unknown>): Record<string, unknown> {
  return new Proxy(impl, {
    get(target, prop, receiver) {
      if (typeof prop !== 'string' || prop in target) return Reflect.get(target, prop, receiver);
      if (prop.startsWith('on') || prop === 'then') return undefined;
      return async (..._args: unknown[]) => {
        reportMiss(group, prop);
        return { ok: false, error: `не реализовано в спайке: ${group}.${prop}` };
      };
    },
  });
}

const SPIKE_VERSION = '0.0.1-android-spike';

const matrica = {
  ping: async () => 'pong',
  log: stubGroup('log', {
    send: async (level: string, message: string) => {
      // eslint-disable-next-line no-console
      console.log(`[renderer:${level}] ${message}`);
    },
  }),
  activity: stubGroup('activity', {
    report: () => {
      /* fire-and-forget; no-op in the spike */
    },
  }),
  app: stubGroup('app', {
    version: async () => SPIKE_VERSION,
    respondToCloseRequest: () => {
      /* no window lifecycle outside Electron */
    },
  }),
  auth: stubGroup('auth', {
    status: async () => ({ loggedIn: false, user: null, permissions: null }),
    sync: async () => ({ loggedIn: false, user: null, permissions: null }),
    loginMru: async () => ({ ok: true, logins: [] }),
    loginSuggest: async (_args: { q: string }) => ({ ok: true, rows: [] }),
    login: async (_args: { username: string; password: string }) => ({
      ok: false,
      error: 'Спайк Ф0: вход появится в Ф1 (порт auth + sync).',
    }),
    logout: async () => ({ ok: true }),
  }),
  engines: stubGroup('engines', {
    list: async () => [],
  }),
  settings: stubGroup('settings', {
    uiGet: async () => ({ ok: true, theme: 'light', chatSide: 'right' }),
    uiSet: async () => ({ ok: true, theme: 'light', chatSide: 'right' }),
    uiControlGet: async () => ({ ok: false, error: 'спайк: глобальные умолчания недоступны' }),
    releaseWelcomeGet: async () => ({
      ok: true,
      shouldShow: false,
      currentVersion: SPIKE_VERSION,
      previouslySeenVersion: null,
    }),
    releaseWelcomeAcknowledge: async () => ({ ok: true }),
  }),
  shortcuts: stubGroup('shortcuts', {
    get: async () => ({ ok: true, ids: [] }),
    set: async (args: { ids: string[] }) => ({ ok: true, ids: args?.ids ?? [] }),
  }),
  sync: stubGroup('sync', {
    status: async () => ({ ok: false, error: 'спайк: sync-движок появится в Ф1' }),
    run: async () => ({ ok: false, error: 'спайк: sync-движок появится в Ф1' }),
  }),
  backups: stubGroup('backups', {
    status: async () => ({ ok: true, mode: 'live', backupDate: null }),
  }),
  server: stubGroup('server', {
    health: async () => ({ ok: false, error: 'спайк: без сети' }),
  }),
  access: stubGroup('access', {
    sectionsSelf: async () => ({ ok: true, sections: null }),
  }),
  presence: stubGroup('presence', {
    me: async () => ({ ok: false, error: 'спайк' }),
  }),
  drafts: stubGroup('drafts', {
    list: async () => ({ ok: true, drafts: [] }),
    clear: async () => ({ ok: true }),
  }),
  notes: stubGroup('notes', {
    burningCount: async () => ({ ok: true, count: 0 }),
  }),
};

// Unknown GROUP access also fails soft-and-loud (returns a stub group).
(window as unknown as { matrica: unknown }).matrica = new Proxy(matrica, {
  get(target, prop, receiver) {
    if (typeof prop !== 'string' || prop in target) return Reflect.get(target, prop, receiver);
    if (prop === 'then') return undefined;
    reportMiss('<root>', prop);
    return stubGroup(prop, {});
  },
});

console.info('[matrica-shim] F0 spike bridge installed');

// Модуль подключается динамически (src/main.tsx выбирает мост по платформе) —
// без экспорта TypeScript не считает файл модулем.
export {};
