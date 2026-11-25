// F0 spike bridge: enough of window.matrica for the renderer to boot to the
// login screen outside Electron. Real implementations arrive in F1
// (docs/plans/android-tablet-client-2026-08.md).
//
// Contract discovery is the point of the spike, so unknown METHOD access on a
// known group loudly logs and returns { ok: false } instead of crashing —
// EXCEPT `on*` subscription props, which must stay undefined so the
// renderer's existence guards (sync.onProgress, app.onCloseRequest, …)
// fail closed instead of receiving a non-function.
//
// ИСКЛЮЧЕНИЕ из этого правила — подписки, которые renderer зовёт БЕЗ проверки
// наличия (files.onProgress, drafts.onChanged): там «undefined» роняет оболочку
// в белый экран, и планшетную раскладку нечем посмотреть без устройства.

import { PermissionCode } from '@matricarmz/shared';

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
//
// `?spikeRole=<роль>` — роль фиктивного пользователя. Нужна, чтобы смотреть меню
// глазами ОПЕРАТОРА, а не суперадмина: операторский пресет сужает меню только
// не-суперадмину (`operatorMenuPreset && userRole !== 'superadmin'`), поэтому на
// суперадмине сужение пресета не видно — а проверить его надо.
const spikeLogin = (() => {
  try {
    return new URLSearchParams(window.location.search).has('spikeLogin');
  } catch {
    return false;
  }
})();

const spikeRole = (() => {
  try {
    const raw = new URLSearchParams(window.location.search).get('spikeRole');
    return raw && raw.trim() ? raw.trim() : 'superadmin';
  } catch {
    return 'superadmin';
  }
})();

// Полный набор прав, которые читает deriveUiCaps: без них меню пустое и смотреть
// планшетную раскладку не на чем.
//
// Права берём из ОБЩЕГО реестра `PermissionCode` (shared), а не перечисляем руками:
// ручной список устаревал и молча срезал разделы (ПП, печатные формы, дети были
// не видны — и это выглядело как «раздел вырезан на планшете», хотя на самом деле
// не хватало права в фикстуре). Теперь фикстура не может отстать от реестра.
const SPIKE_PERMISSIONS = Object.fromEntries(
  Object.values(PermissionCode).map((code) => [code, true]),
);

const SPIKE_AUTH = spikeLogin
  ? {
      loggedIn: true,
      user: { id: 'spike-user', username: 'spike', role: spikeRole, fullName: 'Спайк' },
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
    // Та же форма, что у Electron и у моста на устройстве: `{ ok, version }`.
    version: async () => ({ ok: true as const, version: SPIKE_VERSION }),
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
    // Источник membership для спайка — «не засеяно» (fail-open): гейт разделов не
    // применяется, значит и говорить о нём нечего. Настоящий источник (реплика или
    // замороженное EAV-зеркало) приходит из живого канала `access:sections:self:source`.
    sectionsSelfSource: async () => 'none',
  }),
  presence: stubGroup('presence', {
    me: async () => ({ ok: false, error: 'спайк' }),
  }),
  drafts: stubGroup('drafts', {
    list: async () => ({ ok: true, drafts: [] }),
    clear: async () => ({ ok: true }),
    // Подписка «черновики изменились» (App.tsx зовёт её БЕЗ проверки наличия —
    // в отличие от sync.onProgress/app.onCloseRequest). Настоящий preload её
    // отдаёт всегда, поэтому и спайк обязан: иначе оболочка падает в белый
    // экран и планшетную раскладку нечем посмотреть без устройства.
    onChanged: () => () => {},
  }),
  files: stubGroup('files', {
    // То же самое для прогресса передачи файлов (useFileTransfers зовёт подписку
    // без проверки). Событий в спайке не бывает — подписка просто молчит.
    onProgress: () => () => {},
    progressList: async () => [],
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
