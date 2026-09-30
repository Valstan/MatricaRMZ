import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { cardSourceOf, evaluateDecision, formatStageDay, type DecisionTargetState, type StageOrderDecision } from './reviewRepairStageOrder.js';

const DEFECT_AT = Date.parse('2025-08-26');
const LATER_AT = Date.parse('2025-08-23');

const decision = (over: Partial<StageOrderDecision> = {}): StageOrderDecision => ({
  target: 'stage',
  engine_number: 'Т04АТ6880',
  engine_id: 'engine-1',
  row_id: 'row-1',
  stage_code: 'shipped',
  expect_at: LATER_AT,
  expect_defect_at: DEFECT_AT,
  action: 'set-date',
  at: Date.parse('2025-10-01'),
  ...over,
});

const state = (over: Partial<DecisionTargetState> = {}): DecisionTargetState => ({
  exists: true,
  engineId: 'engine-1',
  engineNumber: 'Т04АТ6880',
  stageCode: 'shipped',
  at: LATER_AT,
  defectAt: DEFECT_AT,
  inConflict: true,
  ...over,
});

/**
 * Проход правит ЖИВЫЕ данные продовой истории ремонта, и вся его безопасность держится на
 * `evaluateDecision`. Ошибись она в сторону «применить» — строки этапов уезжают с датами,
 * которых в заводском учёте никогда не было, а откат возможен только из бэкапа.
 */
describe('evaluateDecision', () => {
  it('решение, совпавшее с экраном разбора, применяется', () => {
    const check = evaluateDecision(decision(), state());
    expect(check).toEqual({ ok: true, action: 'set-date', at: Date.parse('2025-10-01') });
  });

  it('без решения владельца (action: null) ничего не делает', () => {
    expect(evaluateDecision(decision({ action: null }), state())).toEqual({ ok: false, reason: 'no_verdict' });
  });

  it('расхождение даты, которую видели при разборе, — отказ, а не запись поверх', () => {
    expect(evaluateDecision(decision(), state({ at: LATER_AT + 86_400_000 }))).toEqual({
      ok: false,
      reason: 'date_changed',
    });
  });

  it('сдвинулась дата дефектовки — решение «про порядок» больше не о том же', () => {
    expect(evaluateDecision(decision(), state({ defectAt: DEFECT_AT + 86_400_000 }))).toEqual({
      ok: false,
      reason: 'defect_date_moved',
    });
  });

  it('строка сменила этап — это уже другая строка, даже при той же дате', () => {
    expect(evaluateDecision(decision(), state({ stageCode: 'accepted' }))).toEqual({
      ok: false,
      reason: 'stage_code_changed',
    });
  });

  it('номер двигателя разошёлся (решение списали на другой карточке)', () => {
    expect(evaluateDecision(decision(), state({ engineNumber: 'Ж11АТ6962' }))).toEqual({
      ok: false,
      reason: 'engine_mismatch',
    });
  });

  it('строка исчезла или уже удалена — отказ, а не пересоздание', () => {
    expect(evaluateDecision(decision(), state({ exists: false }))).toEqual({ ok: false, reason: 'target_missing' });
  });

  it('строка, не помеченная конфликтной, недоступна: инструмент не общий редактор дат', () => {
    expect(evaluateDecision(decision(), state({ inConflict: false }))).toEqual({ ok: false, reason: 'row_not_in_conflict' });
  });

  it('дата дефектовки неприкосновенна: её ставит вкладка дефектовки, а не этот проход', () => {
    // Сценарий недостижим из `--emit` (строка дефектовки не эмитится) — гвард держит на случай
    // правки файла решений руками.
    const del = decision({ action: 'delete-row', stage_code: 'disassembly_defect' });
    expect(evaluateDecision(del, state({ stageCode: 'disassembly_defect' }))).toEqual({
      ok: false,
      reason: 'defect_stage_protected',
    });
  });

  it('новая дата, остающаяся раньше дефектовки, требует явного согласия', () => {
    const stillEarly = decision({ at: Date.parse('2025-08-25') });
    expect(evaluateDecision(stillEarly, state())).toEqual({ ok: false, reason: 'out_of_order_without_ack' });
    expect(evaluateDecision({ ...stillEarly, allow_out_of_order: true }, state())).toEqual({
      ok: true,
      action: 'set-date',
      at: Date.parse('2025-08-25'),
    });
  });

  it('удаление строки и очистка атрибута не путают мишени', () => {
    expect(evaluateDecision(decision({ action: 'clear-date' }), state())).toEqual({
      ok: false,
      reason: 'action_target_mismatch',
    });
    expect(evaluateDecision(decision({ target: 'card', action: 'delete-row', attribute_code: 'defect_date' }), state())).toEqual({
      ok: false,
      reason: 'action_target_mismatch',
    });
  });

  it('атрибут карточки: значение сошлось — можно чистить', () => {
    const card = decision({ target: 'card', attribute_code: 'status_customer_accepted_date', action: 'clear-date' });
    const cardState = state({ stageCode: null, at: LATER_AT, inConflict: true });
    expect(evaluateDecision(card, cardState)).toEqual({ ok: true, action: 'clear-date', at: null });
    expect(evaluateDecision(card, state({ stageCode: null, at: LATER_AT + 1, inConflict: true }))).toEqual({
      ok: false,
      reason: 'attr_changed',
    });
  });

  it('атрибут вне списка дат-источников отвергается: иначе это общий редактор EAV на проде', () => {
    const card = decision({ target: 'card', attribute_code: 'engine_number', action: 'set-date' });
    expect(evaluateDecision(card, state({ stageCode: null }))).toEqual({ ok: false, reason: 'attr_not_allowed' });
  });

  it('мусорная новая дата и неполное решение не проходят', () => {
    expect(evaluateDecision(decision({ at: Number.NaN }), state())).toEqual({ ok: false, reason: 'bad_new_date' });
    // `row_id: undefined` тип не пускает (exactOptionalPropertyTypes) — мишень без id вручную.
    const { row_id: _dropped, ...withoutRowId } = decision();
    void _dropped;
    expect(evaluateDecision(withoutRowId, state())).toEqual({ ok: false, reason: 'incomplete_decision' });
    // Опечатка в `action` иначе упала бы в ветку set-date и записала `at: null`.
    expect(evaluateDecision(decision({ action: 'wtf' as never }), state())).toEqual({ ok: false, reason: 'unknown_action' });
  });
});

describe('cardSourceOf', () => {
  it('отгрузка/приёмка — копия даты статуса карточки, и копия точная', () => {
    expect(cardSourceOf('shipped', LATER_AT, { status_customer_sent_date: LATER_AT })).toEqual({
      attr: 'status_customer_sent_date',
      exact: true,
    });
  });

  it('расхождение с карточкой видно сразу — значит, строка и источник правятся раздельно', () => {
    expect(cardSourceOf('accepted', LATER_AT, { status_customer_accepted_date: DEFECT_AT })).toEqual({
      attr: 'status_customer_accepted_date',
      exact: false,
    });
  });

  it('ремонтный этап источника на карточке не имеет — и это не ошибка', () => {
    expect(cardSourceOf('obkatka', LATER_AT, {})).toBeNull();
  });

  it('отсутствие даты на карточке не выдаётся за копию', () => {
    expect(cardSourceOf('shipped', LATER_AT, {})).toEqual({ attr: 'status_customer_sent_date', exact: false });
  });
});

describe('formatStageDay', () => {
  it('дата этапа печатается по Москве, а не по UTC', () => {
    // Дата этапа = полночь локальной машины оператора: в ms это 21:00 UTC предыдущих суток.
    // Форматтер по UTC печатал на сутки раньше, и отчёт противоречил экрану (поймано на проде
    // 30.09 — вердикт владельца принимался бы не по тому дню).
    const mskMidnight = Date.UTC(2026, 8, 14, 21, 0, 0);
    expect(new Date(mskMidnight).toISOString().slice(0, 10)).toBe('2026-09-14');
    expect(formatStageDay(mskMidnight).trim()).toBe('15.09.2026');
  });

  it('без даты печатает прочерк, а не 1970', () => {
    expect(formatStageDay(null).trim()).toBe('—');
  });
});

describe('регистрация инструмента', () => {
  it('команда stages:review-order есть в package.json и указывает на этот файл', () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts['stages:review-order']).toBe('tsx src/scripts/reviewRepairStageOrder.ts');
  });
});
