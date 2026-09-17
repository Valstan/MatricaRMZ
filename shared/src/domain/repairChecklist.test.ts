import { describe, expect, it } from 'vitest';

import { fillCrankcaseStampedNumbers, isCrankcaseRowName, resolveHeaderAutofill } from './repairChecklist.js';

describe('resolveHeaderAutofill', () => {
  it('заполняет пустое поле, к которому никто не прикасался', () => {
    expect(resolveHeaderAutofill({ current: '', incoming: '2Ж03АТ', owned: undefined })).toEqual({
      action: 'write',
      value: '2Ж03АТ',
    });
  });

  it('догоняет карточку, пока в поле лежит ровно наша прежняя подстановка', () => {
    // Карточка двигателя шлёт состояние на каждое нажатие: 2 → 2Ж → 2Ж0.
    let owned: string | undefined;
    let current = '';
    for (const incoming of ['2', '2Ж', '2Ж0']) {
      const d = resolveHeaderAutofill({ current, incoming, owned });
      expect(d).toEqual({ action: 'write', value: incoming });
      current = incoming;
      owned = incoming;
    }
    expect(current).toBe('2Ж0');
  });

  it('после перезагрузки листа перенимает поле, совпадающее с карточкой, и догоняет её дальше', () => {
    // Ровно тот случай, когда «доезжала только первая буква»: до перезагрузки мы успели
    // записать в акт начало номера, а `load()` стёр память владения — и дальше поле
    // выглядело чужим непустым, то есть навсегда замирало на первом символе.
    const adopted = resolveHeaderAutofill({ current: '2', incoming: '2', owned: undefined });
    expect(adopted).toEqual({ action: 'adopt', value: '2' });

    // Владение перенято — следующее нажатие в карточке доезжает до акта.
    expect(resolveHeaderAutofill({ current: '2', incoming: '2Ж', owned: '2' })).toEqual({
      action: 'write',
      value: '2Ж',
    });
  });

  it('не трогает поле, которое оператор правил руками', () => {
    expect(resolveHeaderAutofill({ current: 'свой номер', incoming: '2Ж03', owned: '2Ж' })).toEqual({ action: 'skip' });
  });

  it('не трогает чужое непустое поле после перезагрузки листа (владения не помним)', () => {
    expect(resolveHeaderAutofill({ current: '2Ж03', incoming: 'другой', owned: undefined })).toEqual({
      action: 'skip',
    });
  });

  it('не возвращает значение в поле, очищенное оператором', () => {
    expect(resolveHeaderAutofill({ current: '', incoming: '2Ж03', owned: '2Ж03' })).toEqual({ action: 'skip' });
  });

  it('молчит, когда карточка пуста или значение уже совпадает и оно наше', () => {
    expect(resolveHeaderAutofill({ current: '', incoming: '', owned: undefined })).toEqual({ action: 'skip' });
    expect(resolveHeaderAutofill({ current: '2Ж03', incoming: '2Ж03', owned: '2Ж03' })).toEqual({ action: 'skip' });
  });
});

describe('fillCrankcaseStampedNumbers', () => {
  const rows = () => [
    { part_name: 'Картер верхний', stamped_number: '' },
    { part_name: 'Картер нижний', stamped_number: '' },
    { part_name: 'Вал коленчатый', stamped_number: '' },
  ];

  it('ставит номер двигателя обеим половинам картера и не трогает остальные детали', () => {
    const out = fillCrankcaseStampedNumbers({ rows: rows(), engineNumber: '2Ж03АТ' });
    expect(out.changed).toBe(true);
    expect(out.rows.map((r) => r.stamped_number)).toEqual(['2Ж03АТ', '2Ж03АТ', '']);
  });

  it('не перетирает то, что оператор прочитал с металла', () => {
    const src = rows();
    src[0]!.stamped_number = '17-0042';
    const out = fillCrankcaseStampedNumbers({ rows: src, engineNumber: '2Ж03АТ' });
    expect(out.rows.map((r) => r.stamped_number)).toEqual(['17-0042', '2Ж03АТ', '']);
  });

  it('второй прогон ничего не меняет — иначе автосейв уходил бы на каждую перерисовку', () => {
    const once = fillCrankcaseStampedNumbers({ rows: rows(), engineNumber: '2Ж03АТ' });
    const twice = fillCrankcaseStampedNumbers({ rows: once.rows, engineNumber: '2Ж03АТ' });
    expect(twice.changed).toBe(false);
  });

  it('без номера двигателя молчит', () => {
    expect(fillCrankcaseStampedNumbers({ rows: rows(), engineNumber: '   ' }).changed).toBe(false);
  });

  it('узнаёт картер так же, как авто-брак двигателя — по слову в названии', () => {
    // Признак обязан совпадать с engineService (картер в утиле ⇒ двигатель забракован):
    // разойдись они, одна и та же деталь считалась бы картером в одном месте и нет в другом.
    expect(isCrankcaseRowName('Картер верхний')).toBe(true);
    expect(isCrankcaseRowName('КАРТЕР НИЖНИЙ')).toBe(true);
    expect(isCrankcaseRowName('Картер маховика')).toBe(true);
    expect(isCrankcaseRowName('Вал коленчатый')).toBe(false);
    expect(isCrankcaseRowName(undefined)).toBe(false);
  });
});

describe('отметка «своё ФИО уже предлагали» живёт в самом листе (D6)', async () => {
  const { readSignaturePrefillMark, withSignaturePrefillMark, SIGNATURE_PREFILL_MARK_KEY } = await import('./repairChecklist.js');
  it('пустой лист — никому не предлагали; отметка читается обратно и не плодит дублей', () => {
    expect([...readSignaturePrefillMark({})]).toEqual([]);
    const marked = withSignaturePrefillMark({}, ['sig_b', 'sig_a', 'sig_b', '']);
    expect(marked[SIGNATURE_PREFILL_MARK_KEY]).toEqual({ kind: 'text', value: 'sig_a,sig_b' });
    expect([...readSignaturePrefillMark(marked)].sort()).toEqual(['sig_a', 'sig_b']);
    const more = withSignaturePrefillMark(marked, ['sig_c']);
    expect([...readSignaturePrefillMark(more)].sort()).toEqual(['sig_a', 'sig_b', 'sig_c']);
  });
  it('чужое значение под ключом не ломает чтение', () => {
    expect([...readSignaturePrefillMark({ [SIGNATURE_PREFILL_MARK_KEY]: { kind: 'boolean', value: true } })]).toEqual([]);
  });
});
