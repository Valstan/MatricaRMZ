// Гейт Ф2: НАСТОЯЩИЙ мост window.matrica — реальный preload Electron-клиента →
// in-process шина электрон-шима → реальные ipc/register/*-модули → портированные
// сервисы → SQLite (better-sqlite3-адаптер). Ничего из цепочки не замокано,
// кроме сервера (globalThis.fetch) и самой SQLite-платформы.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { startBridgeHarness, type BridgeHarness } from './testing/bridgeHarness.js';

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
