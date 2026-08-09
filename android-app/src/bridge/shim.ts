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

// `?spikeLogin=1` — фиктивный вход ТОЛЬКО в браузерном спайке (на устройстве работает
// настоящий мост, этот файл туда не подключается). Нужен, чтобы смотреть и править
// планшетную раскладку оболочки без планшета: до входа оболочки v3 нет вовсе, а
// именно она и её панели — предмет планшетных правок. Данных не будет (все прочие
// методы возвращают пустое), но раскладка, жесты и скрытие панелей проверяются.
const spikeLogin = (() => {
  try {
    return new URLSearchParams(window.location.search).has('spikeLogin');
  } catch {
    return false;
  }
})();

// Полный набор ключей, которые читает deriveUiCaps: без них меню пустое и смотреть
// планшетную раскладку не на чем.
const SPIKE_PERMISSIONS = Object.fromEntries(
  [
    'admin.users.manage', 'contracts.edit', 'employees.create', 'employees.view',
    'engines.disassemble_confirm', 'engines.edit', 'engines.view', 'files.upload', 'files.view',
    'masterdata.edit', 'masterdata.view', 'movements.revert', 'operations.edit', 'operations.view',
    'parts.create', 'parts.delete', 'parts.edit', 'parts.view',
    'reports.export', 'reports.print', 'reports.view',
    'supply_requests.accept', 'supply_requests.create', 'supply_requests.director_approve',
    'supply_requests.edit', 'supply_requests.fulfill', 'supply_requests.print',
    'supply_requests.sign', 'supply_requests.view', 'sync.use',
    'timesheet.edit', 'timesheet.print', 'timesheet.view', 'updates.use',
    'warehouse.assembly_return', 'warehouse_locations.manage', 'warehouse_locations.view',
    'work_order_templates.edit', 'work_orders.assembly_shortage_approve', 'work_orders.close',
    'work_orders.create', 'work_orders.edit', 'work_orders.print', 'work_orders.revert',
    'work_orders.view', 'workshop_repair_templates.edit', 'workshops.manage',
  ].map((k) => [k, true]),
);

const SPIKE_AUTH = spikeLogin
  ? {
      loggedIn: true,
      user: { id: 'spike-user', username: 'spike', role: 'superadmin', fullName: 'Спайк' },
      permissions: SPIKE_PERMISSIONS,
    }
  : { loggedIn: false, user: null, permissions: null };

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
    status: async () => SPIKE_AUTH,
    sync: async () => SPIKE_AUTH,
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
    // Renderer ждёт КАРТУ membership (или null = гейт секций не применяется), а не
    // конверт {ok,…}: объект-конверт трактуется как пустая карта и вырезает из меню
    // все разделы, у которых есть секция, — панель «РАЗДЕЛЫ» оказывается пустой.
    sectionsSelf: async () => null,
  }),
  presence: stubGroup('presence', {
    me: async () => ({ ok: false, error: 'спайк' }),
  }),
  drafts: stubGroup('drafts', {
    list: async () => ({ ok: true, drafts: [] }),
    clear: async () => ({ ok: true }),
  }),
  notes: stubGroup('notes', {
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
