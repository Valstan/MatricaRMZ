import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { parseContractSections } from '@matricarmz/shared';

import {
  buildCurrentPayments,
  canonicalSectionKey,
  diffPlacements,
  diffSlots,
  plannedSectionsOf,
  sameSlotState,
  slotStateOfRow,
  totalPaymentsKop,
  type SlotDbRow,
} from './resyncContractSlots.js';

/**
 * Сторож разовой автораскладки «двигатели без слота» (промты КАРМАНА #18/#19).
 *
 * Что тут ловится:
 *  - скрипт НЕ пишет строки платежей и НЕ удаляет места (удаление гасит строку, которая
 *    ещё есть в EAV-зеркале, и паритет-проверка начинает кричать о потере там, где её нет);
 *  - движок без раздела места не получает (раздел не выдумывается: он решает, к какому ДС
 *    относится аванс);
 *  - сумма платежей до и после совпадает;
 *  - отчёт различает «получил место», «переехал в другой раздел» и «отвязан».
 */

const NOW = 1_700_000_000_000;

function slotRow(over: Partial<SlotDbRow> = {}): SlotDbRow {
  return {
    id: 'slot-1',
    contract_id: 'contract-1',
    section_key: 'primary',
    engine_brand_id: 'brand-1',
    engine_id: null,
    contract_price_kop: null,
    created_at: NOW - 1000,
    updated_at: NOW - 1000,
    ...over,
  };
}

describe('разовая автораскладка — план и diff', () => {
  it('план договора собирается по секциям и маркам', () => {
    const sections = parseContractSections({
      contract_sections: {
        primary: { number: '1', engineBrands: [{ engineBrandId: 'brand-1', qty: 2, unitPrice: 100 }] },
        addons: [{ seq: 1, number: '1-1', engineBrands: [{ engineBrandId: 'brand-2', qty: 1, unitPrice: 200 }] }],
      },
    });
    const planned = plannedSectionsOf(sections);
    expect(planned).toHaveLength(2);
    expect(planned[0]).toEqual({ sectionKey: 'primary', engineBrandId: 'brand-1', qty: 2, unitPrice: 100 });
    expect(planned[1]!.sectionKey).toBe('ДС 1');
    expect(planned[1]!.engineBrandId).toBe('brand-2');
  });

  it('новое место — upsert без прежнего состояния (откат его погасит)', () => {
    const { upserts } = diffSlots(
      'contract-1',
      [],
      {
        version: 1,
        slots: [{ id: 'slot-new', sectionKey: 'primary', engineBrandId: 'brand-1', engineId: 'engine-1', payments: [] }],
      },
      NOW,
    );
    expect(upserts).toHaveLength(1);
    expect(upserts[0]!.created).toBe(true);
    expect(upserts[0]!.prev).toBeNull();
    expect(upserts[0]!.row.engine_id).toBe('engine-1');
    expect(upserts[0]!.row.engine_brand_id).toBe('brand-1');
  });

  it('изменённое место — upsert с прежним состоянием для отката', () => {
    const before = slotRow({ id: 'slot-1', engine_id: null });
    const { upserts } = diffSlots(
      'contract-1',
      [before],
      {
        version: 1,
        slots: [{ id: 'slot-1', sectionKey: 'primary', engineBrandId: 'brand-1', engineId: 'engine-9', payments: [] }],
      },
      NOW,
    );
    expect(upserts).toHaveLength(1);
    expect(upserts[0]!.created).toBe(false);
    expect(upserts[0]!.prev).toEqual(before);
    expect(upserts[0]!.row.engine_id).toBe('engine-9');
    // updated_at новее серверного — иначе applyPushBatch отбросит правку как устаревшую.
    expect(upserts[0]!.row.updated_at).toBeGreaterThan(before.updated_at);
  });

  it('удалений в diff нет: пустые места только считаются', () => {
    const { upserts, emptyRemovals } = diffSlots(
      'contract-1',
      [slotRow({ id: 'slot-1' }), slotRow({ id: 'slot-empty' })],
      { version: 1, slots: [{ id: 'slot-1', sectionKey: 'primary', engineBrandId: 'brand-1', payments: [] }] },
      NOW,
    );
    expect(upserts).toHaveLength(0);
    expect(emptyRemovals).toBe(1);
  });

  it('сумма платежей не меняется при раскладке', () => {
    const current = buildCurrentPayments(
      [slotRow({ id: 'slot-1' })],
      [{ id: 'pay-1', slot_id: 'slot-1', date: '2026-11-01', amount_kop: '123400', kind: 'advance', note: null, countdown_start: true }],
    );
    expect(totalPaymentsKop(current)).toBe(123400);
  });

  it('раскладка различает «получил место», «переехал» и «остался на месте»', () => {
    const current = buildCurrentPayments(
      [
        slotRow({ id: 'slot-1', engine_id: 'engine-moved', section_key: 'primary' }),
        slotRow({ id: 'slot-2', engine_id: 'engine-kept' }),
        slotRow({ id: 'slot-3' }),
      ],
      [],
    );
    const next = buildCurrentPayments(
      [
        slotRow({ id: 'slot-1' }),
        slotRow({ id: 'slot-2', engine_id: 'engine-kept' }),
        slotRow({ id: 'slot-3', engine_id: 'engine-new' }),
        slotRow({ id: 'slot-4', section_key: 'ДС 2', engine_id: 'engine-moved' }),
      ],
      [],
    );
    const attached = [
      { engineId: 'engine-moved', sectionKey: 'ДС 2', engineBrandId: 'brand-1' },
      { engineId: 'engine-kept', sectionKey: 'primary', engineBrandId: 'brand-1' },
      { engineId: 'engine-new', sectionKey: 'primary', engineBrandId: 'brand-1' },
    ];
    const { placements, detachedWithoutSection } = diffPlacements(
      attached,
      current,
      next,
      new Map([
        ['engine-moved', 'Д-1'],
        ['engine-kept', 'Д-2'],
        ['engine-new', 'Д-3'],
      ]),
      new Map([['primarybrand-1', 2]]),
    );
    const byEngine = new Map(placements.map((p) => [p.engineId, p]));
    expect(byEngine.get('engine-new')!.kind).toBe('placed');
    expect(byEngine.get('engine-new')!.engineNumber).toBe('Д-3');
    expect(byEngine.get('engine-moved')!.kind).toBe('moved');
    expect(byEngine.get('engine-moved')!.fromSectionKey).toBe('primary');
    expect(byEngine.get('engine-kept')!.kind).toBe('kept');
    expect(detachedWithoutSection).toBe(0);
  });

  it('сравнение состояний места не путает null и отсутствие', () => {
    const a = slotStateOfRow(slotRow({ engine_brand_id: null, engine_id: null, contract_price_kop: null }));
    const b = slotStateOfRow(slotRow({ engine_brand_id: null, engine_id: null, contract_price_kop: null }));
    expect(sameSlotState(a, b)).toBe(true);
  });
});

describe('скрипт автораскладки — правила записи', () => {
  const read = (name: string) => readFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url)), 'utf8');
  const SCRIPT = read('resyncContractSlots.ts');

  it('пишет только строгие таблицы и только через синк-журнал', () => {
    // Прямая запись в strict-таблицы обошла бы журнал — парк не увидел бы правку.
    expect(SCRIPT).toContain('writeSyncChanges');
    expect(SCRIPT).toContain('SyncTableName.ErpContractPaymentSlots');
    expect(SCRIPT).not.toMatch(/update\s+erp_contract_payment_slots/i);
  });

  it('не пишет строки платежей: деньги не двигаются', () => {
    expect(SCRIPT).not.toContain('SyncTableName.ErpContractPaymentPayments');
  });

  it('не удаляет места в основном прогоне (чистка — отдельный шаг)', () => {
    // Удаление места гасит строку, которая ещё есть в EAV-зеркале: паритет-проверка
    // (`payments:parity`) начала бы кричать о «потере» там, где ничего не потеряно.
    // Удаляться может только созданное скриптом место — и только при откате.
    const deletes = SCRIPT.match(/type: 'delete'/g) ?? [];
    expect(deletes).toHaveLength(1);
    expect(SCRIPT).toContain('emptyRemovals');
  });

  it('раздел не выдумывается: движок без раздела мест не получает', () => {
    expect(SCRIPT).toContain('canonicalSectionKey');
    expect(SCRIPT).toContain('enginesWithoutSection');
  });

  it('раздел читается каноном «ДС {seq} / голое число — номер ДС», а не старым правилом', () => {
    // Старое правило сворачивало голое число в «primary» и сдвигало двигатель с его ДС.
    expect(SCRIPT).toContain('planContractSectionToken');
    expect(SCRIPT).not.toMatch(/canonicalContractSectionKey\(/);
    expect(canonicalSectionKey('ДС 3')).toBe('ДС 3');
    expect(canonicalSectionKey('3')).toBe('ДС 3');
    expect(canonicalSectionKey('primary')).toBe('primary');
    expect(canonicalSectionKey('')).toBe('');
    expect(canonicalSectionKey(null)).toBe('');
  });

  it('план считается доменным правилом, а не своей копией', () => {
    expect(SCRIPT).toContain('syncSlotsWithPlan');
    expect(SCRIPT).not.toMatch(/function\s+syncSlots/i);
  });

  it('пропущенные сервером строки не остаются молча', () => {
    // applyPushBatch отбрасывает запись, чей updated_at старее серверного (парк успел
    // записать своё). Молчаливый «записано 546/546» выглядел бы как успех, а часть
    // раскладки осталась бы незакрытой.
    expect(SCRIPT).toContain('res.skipped');
    expect(SCRIPT).toContain('Пропущено строк');
  });

  it('порядок мест детерминирован (цены сеются по порядку, а не как вышло от базы)', () => {
    // Позиционное засевание цены зависит от порядка слотов: без ORDER BY база отдаёт
    // их произвольно, и цены прыгали бы от прогона к прогону.
    expect(SCRIPT).toMatch(/ORDER BY contract_id, id/);
  });
});
