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

  it('незарегистрированный домен (файлы) отвечает мягким отказом, а не падением', async () => {
    const res = await h.matrica().files.pick();
    expect(res.ok).toBe(false);
    expect(res.ok ? '' : res.error).toContain('недоступно на планшете');
  });

  it('server.health ходит фейк-сервером через настоящий authAndSync-модуль', async () => {
    const res = await h.matrica().server.health();
    expect(res.ok).toBe(true);
  });
});
