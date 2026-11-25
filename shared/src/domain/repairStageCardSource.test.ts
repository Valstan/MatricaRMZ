import { describe, expect, it } from 'vitest';

import {
  CARD_DATE_STAGE_CODES,
  CARD_SOURCE_ATTR,
  cardDateStageAttr,
  cardSourceAttr,
  stageCodeForCardAttr,
} from './repairStageCardSource.js';
import { buildRepairHistoryMeta, parseRepairHistoryMeta } from './engineRepairHistory.js';

/**
 * Связь строки этапа с датой карточки (промты КАРМАНА #133/#136).
 *
 * Два правила проверяем здесь: список «код этапа → атрибут карточки» — один на рантайм
 * и серверный разбор; и след источника в `meta` переживает разбор (парсер режет
 * неизвестные ключи — поле, положенное только в сборщик, пропало бы при первом чтении).
 */
describe('карта «этап → атрибут карточки»', () => {
  it('этапы приёмки/отгрузки/приёмки заказчиком знают свой источник', () => {
    expect(cardSourceAttr('arrival')).toBe('arrival_date');
    expect(cardSourceAttr('shipped')).toBe('status_customer_sent_date');
    expect(cardSourceAttr('accepted')).toBe('status_customer_accepted_date');
    expect(cardSourceAttr('disassembly_defect')).toBe('defect_date');
  });

  it('ремонтные этапы источника не имеют: они пришли из строк ведомостей', () => {
    expect(cardSourceAttr('obkatka')).toBeNull();
    expect(cardSourceAttr('sborka')).toBeNull();
    expect(cardSourceAttr('otk')).toBeNull();
    expect(cardSourceAttr('card_created')).toBeNull();
    expect(cardSourceAttr('такого этапа нет')).toBeNull();
  });

  it('обратный переход по атрибуту однозначен', () => {
    expect(stageCodeForCardAttr('arrival_date')).toBe('arrival');
    expect(stageCodeForCardAttr('status_customer_accepted_date')).toBe('accepted');
    expect(stageCodeForCardAttr('такого атрибута нет')).toBeNull();
  });

  it('рантайм ведёт за датой карточки ровно трёх этапов', () => {
    expect([...CARD_DATE_STAGE_CODES].sort()).toEqual(['accepted', 'arrival', 'shipped']);
    expect(cardDateStageAttr('arrival')).toBe('arrival_date');
    expect(cardDateStageAttr('obkatka')).toBeNull();
    // Список в карте и список рантайма не разъезжаются: этап, за которым следит
    // рантайм, обязан быть в карте источников.
    for (const code of CARD_DATE_STAGE_CODES) {
      expect(cardDateStageAttr(code)).toBe(CARD_SOURCE_ATTR[code]);
    }
  });
});

describe('след источника в meta строки этапа', () => {
  it('сборка и разбор сохраняют источник', () => {
    const meta = buildRepairHistoryMeta({
      action: 'Приемка двигателя на завод',
      at: 1_700_000_000_000,
      entryType: 'stage',
      stage: { code: 'arrival', name: 'Приемка двигателя на завод' },
      source: { kind: 'card_date', attr: 'arrival_date' },
    });
    const parsed = parseRepairHistoryMeta(JSON.stringify(meta));
    expect(parsed?.source).toEqual({ kind: 'card_date', attr: 'arrival_date' });
  });

  it('пометка погашения переживает разбор', () => {
    const meta = buildRepairHistoryMeta({
      action: 'Приемка двигателя на завод',
      at: 1_700_000_000_000,
      entryType: 'stage',
      stage: { code: 'arrival', name: 'Приемка двигателя на завод' },
      source: { kind: 'card_date', attr: 'arrival_date' },
      extinguished: { attr: 'arrival_date', by: 'petrov', at: 1_700_000_500_000 },
    });
    const parsed = parseRepairHistoryMeta(JSON.stringify(meta));
    expect(parsed?.extinguished).toEqual({ attr: 'arrival_date', by: 'petrov', at: 1_700_000_500_000 });
  });

  it('старые записи читаются как раньше: полей нет — значит нет', () => {
    const parsed = parseRepairHistoryMeta(
      JSON.stringify({
        kind: 'repair_history',
        action: 'Приемка двигателя на завод',
        entryType: 'stage',
        stage: { code: 'arrival', name: 'Приемка двигателя на завод' },
        at: 1_700_000_000_000,
      }),
    );
    expect(parsed?.source).toBeUndefined();
    expect(parsed?.extinguished).toBeUndefined();
  });

  it('чужой вид следа отбрасывается: неизвестный след ничего не значит', () => {
    const parsed = parseRepairHistoryMeta(
      JSON.stringify({
        kind: 'repair_history',
        action: 'Приемка двигателя на завод',
        entryType: 'stage',
        stage: { code: 'arrival', name: 'Приемка двигателя на завод' },
        source: { kind: 'что-то ещё', attr: 'arrival_date' },
      }),
    );
    expect(parsed?.source).toBeUndefined();
  });
});
