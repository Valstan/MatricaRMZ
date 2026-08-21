import { describe, expect, it } from 'vitest';

import {
  HUMAN_LABEL_DASH,
  hasHumanLabel,
  humanLabel,
  humanLabelDomainCodes,
  looksLikeIdentifier,
  pickHumanText,
  reportTotalKind,
} from './humanLabels.js';

const UUID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

describe('looksLikeIdentifier', () => {
  it('распознаёт идентификатор в любом регистре и с пробелами по краям', () => {
    expect(looksLikeIdentifier(UUID)).toBe(true);
    expect(looksLikeIdentifier(UUID.toUpperCase())).toBe(true);
    expect(looksLikeIdentifier(`  ${UUID}  `)).toBe(true);
  });

  it('не принимает за идентификатор человеческое название с дефисами', () => {
    expect(looksLikeIdentifier('Д-245')).toBe(false);
    expect(looksLikeIdentifier('DIESEL-2024-A')).toBe(false);
    expect(looksLikeIdentifier('ЯМЗ-238')).toBe(false);
  });

  it('не срабатывает на обрывке идентификатора и на не-строке', () => {
    expect(looksLikeIdentifier(UUID.slice(0, 8))).toBe(false);
    expect(looksLikeIdentifier(`№${UUID}`)).toBe(false);
    expect(looksLikeIdentifier(null)).toBe(false);
    expect(looksLikeIdentifier(42)).toBe(false);
  });
});

describe('pickHumanText', () => {
  it('берёт первый непустой кандидат', () => {
    expect(pickHumanText('', '  ', 'Д-245', 'ЯМЗ')).toBe('Д-245');
  });

  it('пропускает идентификатор и берёт следующий кандидат', () => {
    expect(pickHumanText(UUID, 'Д-245')).toBe('Д-245');
  });

  it('отдаёт пустую строку, когда человеческого текста нет вовсе', () => {
    expect(pickHumanText(UUID, '', null, undefined)).toBe('');
  });
});

describe('humanLabel', () => {
  it('подписывает коды типов операций, которые оператор видел сырьём', () => {
    expect(humanLabel('operation_type', 'engine_inventory')).toBe('Ведомость деталей');
    expect(humanLabel('operation_type', 'work_order')).toBe('Наряд');
    expect(humanLabel('operation_type', 'part_status_event')).toBe('Статус детали');
  });

  it('подписывает фазы двигателя', () => {
    expect(humanLabel('engine_phase', 'received')).toBe('Принят');
    expect(humanLabel('engine_phase', 'in_assembly')).toBe('В сборке');
  });

  it('не путает подпись с полем прототипа — ключ constructor это не подпись', () => {
    expect(humanLabel('operation_type', 'constructor')).toBe(HUMAN_LABEL_DASH);
    expect(humanLabel('report_total', 'toString')).toBe(HUMAN_LABEL_DASH);
  });

  it('распознаёт системный идентификатор, у которого нет версии и варианта', () => {
    expect(looksLikeIdentifier('00000000-0000-0000-0000-000000000001')).toBe(true);
    expect(pickHumanText('00000000-0000-0000-0000-000000000001', 'Приёмка')).toBe('Приёмка');
  });

  it('НИКОГДА не возвращает сам код — неизвестному коду достаётся прочерк', () => {
    expect(humanLabel('operation_type', 'some_new_type')).toBe(HUMAN_LABEL_DASH);
    expect(humanLabel('engine_phase', 'in_assembly_v2')).toBe(HUMAN_LABEL_DASH);
    expect(humanLabel('report_total', 'totallyNewMetric')).toBe(HUMAN_LABEL_DASH);
  });

  it('принимает свою подпись отсутствия и переваривает мусор на входе', () => {
    expect(humanLabel('operation_type', 'nope', '(нет данных)')).toBe('(нет данных)');
    expect(humanLabel('operation_type', '')).toBe(HUMAN_LABEL_DASH);
    expect(humanLabel('operation_type', null)).toBe(HUMAN_LABEL_DASH);
    expect(humanLabel('operation_type', 42)).toBe(HUMAN_LABEL_DASH);
  });

  it('итоги отчётов сведены в один словарь — ключи обеих прежних копий на месте', () => {
    // totalKtu жил только в сборщике main, years — только в предпросмотре рендерера.
    expect(humanLabel('report_total', 'totalKtu')).toBe('КТУ суммарно');
    expect(humanLabel('report_total', 'years')).toBe('Лет в отчёте');
  });
});

describe('reportTotalKind', () => {
  it('проценты узнаются по ключу', () => {
    expect(reportTotalKind('progressPct')).toBe('percent');
    expect(reportTotalKind('fulfillmentPct')).toBe('percent');
  });

  it('деньги узнаются по «rub» — а не только там, где рядом стоит «amount»', () => {
    // Прежнее правило требовало в ключе И «amount», И «rub»: эти шесть ключей печатались
    // голым числом под подписью, обещающей ₽.
    for (const key of ['priceRub', 'paidRub', 'deltaRub', 'finalRub', 'advanceRub', 'extraAdvanceRub']) {
      expect(reportTotalKind(key)).toBe('money');
    }
    expect(reportTotalKind('amountRub')).toBe('money');
    expect(reportTotalKind('totalAmountRub')).toBe('money');
  });

  it('остальное — обычное число', () => {
    expect(reportTotalKind('engines')).toBe('number');
    expect(reportTotalKind('lines')).toBe('number');
    expect(reportTotalKind('avgTatDays')).toBe('number');
  });
});

describe('домены реестра', () => {
  it('покрывают все коды таймлайна двигателя, а не выборочные', () => {
    expect(humanLabelDomainCodes('operation_type')).toHaveLength(29);
    expect(hasHumanLabel('operation_type', 'defect_conducted')).toBe(true);
    expect(hasHumanLabel('operation_type', 'нет_такого')).toBe(false);
  });

  it('ни одна подпись не является идентификатором', () => {
    for (const domain of ['operation_type', 'operation_status', 'engine_phase', 'report_total'] as const) {
      for (const code of humanLabelDomainCodes(domain)) {
        expect(looksLikeIdentifier(humanLabel(domain, code))).toBe(false);
      }
    }
  });
});
