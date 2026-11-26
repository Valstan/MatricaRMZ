// Гейт Ф2: НАСТОЯЩИЙ мост window.matrica — реальный preload Electron-клиента →
// in-process шина электрон-шима → реальные ipc/register/*-модули → портированные
// сервисы → SQLite (better-sqlite3-адаптер). Ничего из цепочки не замокано,
// кроме сервера (globalThis.fetch) и самой SQLite-платформы.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { API, startBridgeHarness, type BridgeHarness } from './testing/bridgeHarness.js';

describe('android bridge smoke (preload → шина → register → сервисы)', () => {
  let h: BridgeHarness;

  beforeEach(async () => {
    h = await startBridgeHarness();
  });

  afterEach(async () => {
    await h.dispose();
  });

  it('auth.status идёт через настоящий preload и видит сессию', async () => {
    const s = await h.matrica().auth.status();
    expect(s.loggedIn).toBe(true);
    expect(s.user?.username).toBe('verify');
  });

  it('двигатель: create → setAttr → list/get, операции и аудит — весь путь до SQLite', async () => {
    // Deferred create: возвращает только {id}, строка в БД появляется первым setAttr.
    const created = await h.matrica().engines.create();
    expect(created.id).toBeTruthy();
    const engineId = created.id;

    // setAttr возвращает void; успех = отсутствие исключения + строка в БД ниже.
    await h.matrica().engines.setAttr(engineId, 'engine_number', 'SM-777');

    const list = await h.matrica().engines.list();
    expect(list.some((r) => r.id === engineId)).toBe(true);

    const details = await h.matrica().engines.get(engineId);
    expect(JSON.stringify(details)).toContain('SM-777');

    await h.matrica().operations.add(engineId, 'repair', 'in_progress', 'смоук');
    const ops = await h.matrica().operations.list(engineId);
    expect(ops.length).toBeGreaterThan(0);

    const audit = await h.matrica().audit.add({ action: 'bridge-smoke', entityId: engineId });
    expect(audit.ok).toBe(true);

    // Строка реально в базе (не в моке).
    const row = await h.adapter.get<{ c: number }>(`SELECT COUNT(*) AS c FROM entities WHERE id = ?`, [engineId]);
    expect(row?.c).toBe(1);
  });

  it('черновики карточек: save → get → clear', async () => {
    const saved = await h.matrica().drafts.save({
      cardType: 'engine',
      cardId: 'e-1',
      payloadJson: JSON.stringify({ note: 'из цеха' }),
    });
    expect(saved.ok).toBe(true);

    const got = await h.matrica().drafts.get({ cardType: 'engine', cardId: 'e-1' });
    expect(got.ok).toBe(true);
    expect(got.ok && String(got.draft?.payloadJson ?? '')).toContain('из цеха');

    const cleared = await h.matrica().drafts.clear({ cardType: 'engine', cardId: 'e-1' });
    expect(cleared.ok).toBe(true);
  });

  it('дефектовка: checklists.engineGet отвечает по пустому двигателю без падения', async () => {
    const created = await h.matrica().engines.create();
    const res = await h.matrica().checklists.engineGet({ engineId: created.id, stage: 'inventory' });
    expect(res).toBeTruthy();
    expect(res.ok ? '' : res.error).not.toContain('не реализовано');
  });

  it('незарегистрированный домен (файлы) отвечает мягким отказом с причиной, а не падением', async () => {
    const res = await h.matrica().files.pick();
    expect(res.ok).toBe(false);
    // Промт КАРМАНА #142: отказ называет причину прямо. Раньше здесь было
    // «недоступно на планшете: <канал>» — одинаково с «нет доступа к разделу»,
    // и оператор с админом гадали, чего не хватает: прав или функции.
    expect(res.ok ? '' : res.error).toContain('канал не заведён на планшете');
    expect(res.ok ? '' : res.error).toContain('файловой системы нет');
  });

  it('избранное разделов: звёздочка в меню кладёт раздел в левую панель (set → get)', async () => {
    // Домен `sections` на планшете не был зарегистрирован: звёздочка нажималась,
    // запись возвращала «недоступно на планшете», и оболочка откатывала выбор —
    // раздел в левом блоке так и не появлялся.
    const set = await h.matrica().sections.favoritesSet({ userId: 'u-1', ids: ['engines', 'work_sheets'] });
    expect(set.ok).toBe(true);

    const got = await h.matrica().sections.favoritesGet({ userId: 'u-1' });
    expect(got.ok).toBe(true);
    const ids = got.ok ? got.ids : [];
    expect(ids).toContain('engines');
    expect(ids).toContain('work_sheets');

    // Чужой scope не видит чужого выбора. ДЕФОЛТНЫЕ разделы (список двигателей и список
    // контрактов) при этом у всех — они и есть «по умолчанию» (владелец 13.11.2026:
    // «многие клиенты сидят с пустой колонкой слева»), а вот СВОЙ выбор оператора
    // остаётся личным.
    const other = await h.matrica().sections.favoritesGet({ userId: 'u-2' });
    expect(other.ok ? other.ids : []).not.toContain('work_sheets');
    expect(other.ok ? other.ids : []).toContain('engines');
    expect(other.ok ? other.ids : []).toContain('contracts');
  });

  it('server.health ходит фейк-сервером через настоящий authAndSync-модуль', async () => {
    const res = await h.matrica().server.health();
    expect(res.ok).toBe(true);
  });
});

/**
 * Промт КАРМАНА #142: «ни один нужный домен не остался незаведённым в мосте
 * планшета». Класс дефекта, который владелец диагностировал как «недостаточно
 * прав»: домен есть в коде, раздел есть в меню, а канал в мосте не заведён —
 * шим отвечает «недоступно на планшете», renderer печатает «Ошибка сохранения: …»,
 * и оператор решает, что запись не уходит.
 *
 * Проверка бьёт по каждому домену, который до промта на планшете не был заведён,
 * и требует: канал отвечает по-настоящему, а не отказом «не заведён».
 */
describe('домены, подключённые по промту #142, отвечают по-настоящему', () => {
  let h: BridgeHarness;

  beforeEach(async () => {
    h = await startBridgeHarness();
  });

  afterEach(async () => {
    await h.dispose();
  });

  it('ни один канал новых доменов не отвечает «не заведён на планшете»', async () => {
    const calls: ReadonlyArray<readonly [string, () => Promise<unknown>]> = [
      ['отчёты', () => h.matrica().reports.presetList()],
      ['табель', () => h.matrica().timesheets.list()],
      ['СИЗ', () => h.matrica().ppe.norms.list()],
      ['инструменты', () => h.matrica().tools.list()],
      ['рекламации двигателей', () => h.matrica().engineReclamations.list('e-1')],
      ['печатные формы', () => h.matrica().printForms.templates.list()],
      ['платежи по контрактам', () => h.matrica().contractPayments.get('c-1')],
      ['цены на услуги', () => h.matrica().servicePricing.orders.list()],
      ['подписи по умолчанию', () => h.matrica().signatureDefaults.list()],
      ['чат', () => h.matrica().chat.usersList()],
      ['ИИ-чат', () => h.matrica().aiChat.list()],
      ['ИИ-агент', () => h.matrica().aiAgent.logEvent({ context: { tab: 'engines' }, event: { type: 'open', ts: Date.now(), tab: 'engines' } })],
      ['экраны UI', () => h.matrica().uiScreens.list()],
      ['критерии утиля', () => h.matrica().scrapCriterion.list()],
      ['снятие утиля двигателя', () => h.matrica().engineScrap.reasons()],
      ['дети', () => h.matrica().children.list()],
      ['организация', () => h.matrica().organization.list()],
      ['обслуживание', () => h.matrica().maintenance.emptyCardsAnalyze()],
      ['системные каналы', () => h.matrica().system.clockStatus()],
    ];

    const notWired: string[] = [];
    const failed: string[] = [];
    for (const [name, call] of calls) {
      const res = await call();
      const text = JSON.stringify(res ?? '');
      if (text.includes('канал не заведён на планшете')) {
        notWired.push(name);
        continue;
      }
      const ok = (res as { ok?: unknown } | null | undefined)?.ok;
      if (ok === false) failed.push(`${name}: ${(res as { error?: string }).error ?? 'без причины'}`);
    }

    expect(notWired, 'домен не заведён в мосте планшета — правка молча не сохранится').toEqual([]);
    expect(failed, 'канал отвечает отказом — проверь право/данные в фикстуре').toEqual([]);
  });

  it('каналы, физически невозможные на планшете, отвечают причиной, а не отказом по разделу', async () => {
    // Печать/PDF считаются в скрытом окне Electron — на планшете такого окна нет.
    // Отказ обязан называть ЭТУ причину: иначе он неотличим от «нет доступа к
    // разделу» и снова выглядит как «недостаточно прав».
    const pdf = await h.matrica().reports.presetPdf({ presetId: 'engines' });
    expect(pdf.ok).toBe(false);
    expect(pdf.ok ? '' : pdf.error).toContain('на планшете не работает');
    expect(pdf.ok ? '' : pdf.error).toContain('скрытом окне Electron');

    // Выгрузка CSV — наоборот, работает (файл не пишется, отдаётся содержимое).
    const csv = await h.matrica().reports.presetCsv({ presetId: 'engines' });
    expect(JSON.stringify(csv)).not.toContain('канал не заведён на планшете');
  });
});

/**
 * Правка СОХРАНЯЕТСЯ — а не просто «канал ответил» (промт КАРМАНА #142, критерий 1).
 *
 * Смоук выше доказывает одно: домен заведён в мосте. Владельцу же жаловались на
 * другое: «правки не сохраняются». Ответ «канал ответил ok» этому не
 * противоречит — запись может уйти в никуда, и оператор увидит «сохранилось».
 *
 * Здесь проверяется второе — для доменов, чья запись уходит СЕРВЕРНОЙ ДВЕРЬЮ
 * (REST). Требование к каждому:
 *   1. правка не отказана (ни «не заведён», ни «нет права», ни «нет доступа»);
 *   2. запрос с планшета УШЁЛ на сервер — нужным методом и по нужному маршруту;
 *   3. в теле запроса — правка оператора, а не пустой вызов;
 *   4. id, который вернул сервер, доехал обратно на планшет.
 *
 * Пункт 2 — главный: без него «сохранилось» ничего не значит, потому что
 * запись могла остаться на устройстве и уйти в никуда.
 */
type WriteCall = { method: string; path: string; body: Record<string, unknown> | null };

/** Перехват серверных запросов: пишем запрос в список и отвечаем как живой сервер. */
function captureWrites(calls: WriteCall[]): (url: string, init?: RequestInit) => Response | null {
  return (url: string, init?: RequestInit): Response | null => {
    const method = String(init?.method ?? 'GET').toUpperCase();
    if (method === 'GET') return null;
    let body: Record<string, unknown> | null = null;
    if (init?.body) {
      try {
        body = JSON.parse(String(init.body)) as Record<string, unknown>;
      } catch {
        body = null;
      }
    }
    calls.push({ method, path: url.startsWith(API) ? url.slice(API.length) : url, body });
    // Сервер отвечает как живой: правка возвращает id, по которому её потом читают.
    return Response.json({ ok: true, id: 'server-id-1' });
  };
}

type WriteCase = {
  /** Имя домена так, как его видит оператор. */
  name: string;
  /** Метод и маршрут серверной двери, которых ждём. */
  method: string;
  path: string;
  /** Правка через настоящий preload моста. */
  call: (h: BridgeHarness) => Promise<{ ok: boolean; id?: string; error?: string }>;
  /** Что должно быть в теле запроса — доказательство, что ушла правка оператора. */
  bodyHas: (body: Record<string, unknown> | null) => boolean;
};

const WRITE_CASES: readonly WriteCase[] = [
  {
    name: 'табель',
    method: 'POST',
    path: '/timesheets',
    call: (h) => h.matrica().timesheets.create({ year: 2026, month: 11, weekMode: 5 }),
    bodyHas: (b) => b?.year === 2026 && b?.month === 11,
  },
  {
    name: 'дети',
    method: 'POST',
    path: '/children',
    call: (h) => h.matrica().children.save({ fullName: 'Проверка Тестова', birthDate: 1_700_000_000_000 }),
    bodyHas: (b) => b?.fullName === 'Проверка Тестова',
  },
  {
    name: 'организация',
    method: 'POST',
    path: '/organization/events',
    call: (h) => h.matrica().organization.saveEvent({ title: 'Проверка: праздник', kind: 'holiday' }),
    bodyHas: (b) => b?.title === 'Проверка: праздник',
  },
  {
    name: 'печатные формы',
    method: 'PUT',
    path: '/print-forms/templates',
    call: (h) =>
      h.matrica().printForms.templates.save({
        entityKey: 'engine',
        name: 'Проверка: акт',
        layoutJson: '{"fields":[]}',
      }),
    bodyHas: (b) => b?.name === 'Проверка: акт' && b?.entityKey === 'engine',
  },
  {
    name: 'цены на услуги',
    method: 'POST',
    path: '/service-pricing/orders',
    call: (h) =>
      h.matrica().servicePricing.orders.upsert({
        orderNumber: 'ПР-1',
        orderDate: 1_700_000_000_000,
        title: 'Проверка: приказ',
        effectiveFrom: 1_700_000_000_000,
      }),
    bodyHas: (b) => b?.orderNumber === 'ПР-1',
  },
  {
    name: 'подписи по умолчанию',
    method: 'POST',
    path: '/signature-defaults',
    call: (h) => h.matrica().signatureDefaults.set({ fieldKey: 'engine_head', employeeId: 'emp-1' }),
    bodyHas: (b) => b?.fieldKey === 'engine_head' && b?.employeeId === 'emp-1',
  },
  {
    name: 'СИЗ',
    method: 'POST',
    path: '/ppe/groups',
    call: (h) => h.matrica().ppe.groups.create({ name: 'Проверка: коллектив' }),
    bodyHas: (b) => b?.name === 'Проверка: коллектив',
  },
  {
    name: 'рекламации двигателей',
    method: 'PUT',
    path: '/engine-reclamations/e-1',
    call: (h) =>
      h.matrica().engineReclamations.save({
        engineId: 'e-1',
        rows: [{ queueNo: 1, customerReason: 'Проверка: заезд' }],
      }),
    bodyHas: (b) => Array.isArray(b?.rows) && (b?.rows as unknown[]).length === 1,
  },
];

describe('правка в доменах промта #142 уходит на сервер и не теряется', () => {
  let h: BridgeHarness | null = null;

  afterEach(async () => {
    await h?.dispose();
    h = null;
  });

  for (const c of WRITE_CASES) {
    it(`${c.name}: правка ушла на сервер и вернула id`, async () => {
      const calls: WriteCall[] = [];
      h = await startBridgeHarness({ routes: captureWrites(calls) });

      const res = await c.call(h);

      // 1. Отказа быть не должно — и отказ должен называть причину, а не молчать.
      expect(res.ok, `правка отказала: ${res.error ?? 'без причины'}`).toBe(true);
      expect(res.error ?? '').not.toContain('канал не заведён на планшете');
      expect(res.error ?? '').not.toContain('Нет доступа к разделу');

      // 2. Запрос ушёл на серверную дверь — нужным методом и маршрутом.
      const write = calls.find((x) => x.method === c.method && x.path === c.path);
      expect(
        write,
        `правка не ушла на сервер: ${c.method} ${c.path} не запрошен (запрошено: ${calls
          .map((x) => `${x.method} ${x.path}`)
          .join(', ')})`,
      ).toBeDefined();

      // 3. В теле — правка оператора.
      expect(c.bodyHas(write!.body), `тело правки не то: ${JSON.stringify(write!.body)}`).toBe(true);

      // 4. id сервера доехал обратно на планшет.
      expect(res.id, 'id сервера не доехал до планшета').toBe('server-id-1');
    });
  }

  it('правка без сети говорит «нужна сеть», а не «нет доступа» и не «не заведён»', async () => {
    // Отказ по сети — штатный для планшета (правки уходят по HTTP в серверные
    // двери). Важно, чтобы оператор видел ПРИЧИНУ: «нужна сеть», а не
    // «недостаточно прав» — иначе вернётся ровно тот диагноз, который владелец
    // поставил неверно.
    //
    // Сетевой сбой приходит ОТКАЗОМ (исключением), а не ответом `{ok:false}` —
    // renderer ловит его и печатает «Ошибка сохранения: <текст>». Поэтому текст
    // достаём из исключения (та же приёмка, что в refusalReasons.smoke.test.ts).
    h = await startBridgeHarness({ offlineAfterLogin: true });
    let text = '';
    try {
      const res = await h.matrica().timesheets.create({ year: 2026, month: 11 });
      text = res.ok ? '' : (res.error ?? '');
    } catch (e) {
      text = String((e as Error)?.message ?? e);
    }
    expect(text).toContain('нужна сеть');
    expect(text).not.toContain('канал не заведён на планшете');
    expect(text).not.toContain('Нет доступа к разделу');
  });
});
