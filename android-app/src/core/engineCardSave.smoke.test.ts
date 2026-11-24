// Гейт записи карточки двигателя на планшете (промт КАРМАНА #111:
// «вносим изменения в карточку двигателя — ничего не сохраняется, на сервер не
// уходит»).
//
// Причина была не в правах и не в синке: домен `engineCards` не был
// зарегистрирован в мосте Android (`android-app/src/core/ipcWiring.ts`), и
// preload отдавал функции, для которых в шине нет хэндлера — шим отвечал
// «недоступно на планшете: engines:card:save». Запись не доходила ни до
// локальной БД, ни до очереди push'а.
//
// Смоук идёт по-настоящему: preload → шина → register-модуль → сервисы →
// SQLite; замокан только сервер (globalThis.fetch).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runSync } from '../../../electron-app/src/main/services/syncService.js';

import { API, ENGINE_NUMBER_DEF_ID, ENGINE_TYPE_ID, startBridgeHarness, type BridgeHarness } from './testing/bridgeHarness.js';

describe('запись карточки двигателя на планшете', () => {
  let h: BridgeHarness;
  const pushBodies: Array<Record<string, unknown>> = [];

  beforeEach(async () => {
    pushBodies.length = 0;
    h = await startBridgeHarness({
      routes: (url, init) => {
        if (url.startsWith(`${API}/ledger/tx/submit`)) {
          const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
          pushBodies.push(body);
          return Response.json({ ok: true, applied: (body.txs as unknown[]).length });
        }
        if (url.startsWith(`${API}/diagnostics/sync-schema`)) {
          return Response.json({ ok: true, schema: { generatedAt: 1, tables: {} } });
        }
        if (url.startsWith(`${API}/ledger/schema/snapshot`)) {
          // Тот же мастер-данный, что сеет обвязка: иначе align-проход счёл бы
          // локальные справочники лишними и снёс бы их вместе с карточкой.
          return Response.json({
            ok: true,
            fingerprint: 'b'.repeat(64),
            entity_types: [
              { id: ENGINE_TYPE_ID, code: 'engine', name: 'Двигатель', created_at: 1, updated_at: 1 },
            ],
            attribute_defs: [
              {
                id: ENGINE_NUMBER_DEF_ID,
                entity_type_id: ENGINE_TYPE_ID,
                code: 'engine_number',
                name: 'Номер',
                data_type: 'text',
                created_at: 1,
                updated_at: 1,
              },
            ],
          });
        }
        if (url.startsWith(`${API}/ledger/state/snapshot`)) {
          const table = new URL(url).searchParams.get('table');
          return Response.json({
            ok: true,
            table,
            rows: [],
            has_more: false,
            next_cursor_id: null,
            server_last_seq: 1,
          });
        }
        if (url.startsWith(`${API}/ledger/state/changes`)) {
          return Response.json({ server_cursor: 1, server_last_seq: 1, has_more: false, changes: [] });
        }
        return null;
      },
    });
  });

  afterEach(async () => {
    await h.dispose();
  });

  it('правка карточки сохраняется в локальной реплике и ждёт отправки', async () => {
    const created = await h.matrica().engines.create();
    const engineId = created.id;
    expect(engineId).toBeTruthy();
    await h.matrica().engines.setAttr(engineId, 'engine_number', 'SM-777');

    const saved = await h.matrica().engines.card.save({
      id: engineId,
      fields: { engine_number: 'SM-777' },
    });
    expect(saved.ok, `запись карточки отвергнута: ${saved.ok ? '' : saved.error}`).toBe(true);

    // Строка реплики легла с sync_status='pending' — то есть уходит на сервер.
    const row = await h.adapter.get<{ sync_status: string; engine_number: string | null }>(
      `SELECT sync_status, engine_number FROM erp_engine_cards WHERE id = ?`,
      [engineId],
    );
    expect(row?.sync_status).toBe('pending');
    expect(row?.engine_number).toBe('SM-777');

    // Чтение через мост отдаёт то, что записали (канал `engines:card:get`).
    const got = await h.matrica().engines.card.get(engineId);
    expect(got.ok).toBe(true);
    expect(got.ok ? String(got.row?.engine_number ?? '') : '').toBe('SM-777');
  });

  it('pending-строка карточки уходит на сервер и подтверждается', async () => {
    const created = await h.matrica().engines.create();
    const engineId = created.id;
    await h.matrica().engines.setAttr(engineId, 'engine_number', 'SM-888');
    const saved = await h.matrica().engines.card.save({
      id: engineId,
      fields: { engine_number: 'SM-888' },
    });
    expect(saved.ok).toBe(true);

    const result = await runSync(h.core.serviceDb, h.core.clientId, API);
    expect(result.error ?? null).toBeNull();
    expect(result.ok).toBe(true);
    expect(result.pushed).toBeGreaterThan(0);

    // Push реально нёс карточку, а не «что-то другое».
    const txs = pushBodies.flatMap((b) => (b.txs as Array<Record<string, unknown>>) ?? []);
    expect(JSON.stringify(txs)).toContain(engineId);

    // После подтверждения сервера строка помечена synced — то есть правка
    // действительно уехала, а не осталась ждать следующего push'а.
    const row = await h.adapter.get<{ sync_status: string }>(
      `SELECT sync_status FROM erp_engine_cards WHERE id = ?`,
      [engineId],
    );
    expect(row?.sync_status).toBe('synced');
  });

  it('пакетный приём двигателей списком на планшете не отвечает «недоступно»', async () => {
    const preview = await h.matrica().engines.bulkIntake.preview({ text: 'АБ-12' });
    expect(preview.ok).toBe(true);
  });
});
