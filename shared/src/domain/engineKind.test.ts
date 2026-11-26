import { describe, expect, it } from 'vitest';

import {
  counterpartyKindFilterNote,
  counterpartyKindHint,
  counterpartyKindVerdict,
  ENGINE_KIND_NONE_VALUE,
  ENGINE_KIND_REQUIRED_MESSAGE,
  ENGINE_KIND_SOURCE_LABELS,
  engineKindFacetLabel,
  engineKindFacetValue,
  engineKindLabel,
  engineKindRequirement,
  filterCounterpartiesByContractKind,
  parseCounterpartyKind,
  resolveEngineKind,
  type EngineKindRequirementSources,
} from './engineKind.js';

// Правило владельца 18.11.2026: вид двигателя (ГОЗ / гражданский) должен быть один и тот же
// в списке, в фильтрах, в отчётах и в карточках, и считаться по одному приоритету:
// договор → карточка двигателя → контрагент.
describe('resolveEngineKind', () => {
  it('договор — первый источник, даже если в карточке стоит другое', () => {
    expect(resolveEngineKind({ contractKind: 'military', cardKind: 'civil' })).toEqual({
      kind: 'military',
      source: 'contract',
    });
  });

  it('появился договор — вид переопределился сам, ручное значение не важно', () => {
    const engine = { cardKind: 'civil' };
    expect(resolveEngineKind(engine)).toEqual({ kind: 'civil', source: 'card' });
    // Тот же двигатель, но теперь у него договор: вид стал гражданским/военным по договору.
    expect(resolveEngineKind({ ...engine, contractKind: 'military' })).toEqual({
      kind: 'military',
      source: 'contract',
    });
  });

  it('без договора вид берётся из карточки', () => {
    expect(resolveEngineKind({ cardKind: 'civil' })).toEqual({ kind: 'civil', source: 'card' });
  });

  it('без договора и без ручного значения — вид заказчика', () => {
    expect(resolveEngineKind({ counterpartyKind: 'military' })).toEqual({
      kind: 'military',
      source: 'counterparty',
    });
  });

  it('источников нет вовсе — вида нет (null), а не «ГОЗ по умолчанию»', () => {
    expect(resolveEngineKind({})).toEqual({ kind: null, source: 'none' });
    expect(resolveEngineKind(null)).toEqual({ kind: null, source: 'none' });
    expect(resolveEngineKind({ contractKind: '', cardKind: '', counterpartyKind: '' })).toEqual({
      kind: null,
      source: 'none',
    });
  });

  it('мусор в значениях не превращается в вид', () => {
    expect(resolveEngineKind({ contractKind: 'grazhdansky', cardKind: 'да' }).kind).toBeNull();
    expect(resolveEngineKind({ cardKind: 42 }).kind).toBeNull();
  });

  it('источник возвращается наружу — интерфейсу нужно объяснить, откуда взято значение', () => {
    expect(resolveEngineKind({ contractKind: 'civil' }).source).toBe('contract');
    expect(resolveEngineKind({ cardKind: 'civil' }).source).toBe('card');
    expect(resolveEngineKind({ counterpartyKind: 'civil' }).source).toBe('counterparty');
    expect(ENGINE_KIND_SOURCE_LABELS.contract).toBe('из договора');
    expect(ENGINE_KIND_SOURCE_LABELS.card).toBe('вручную в карточке');
    expect(ENGINE_KIND_SOURCE_LABELS.counterparty).toBe('из карточки заказчика');
    expect(ENGINE_KIND_SOURCE_LABELS.none).toBe('вид не задан');
  });

  it('подписи: вид — как у договора, отсутствие вида — прочерк', () => {
    expect(engineKindLabel('military')).toBe('ГОЗ');
    expect(engineKindLabel('civil')).toBe('Гражданский');
    expect(engineKindLabel(null)).toBe('—');
  });

  it('в отборе вид без значения — отдельное значение, а не молчаливый пропуск', () => {
    expect(engineKindFacetValue('military')).toBe('military');
    expect(engineKindFacetValue(null)).toBe(ENGINE_KIND_NONE_VALUE);
    expect(engineKindFacetLabel(null)).toBe('Вид не задан');
    expect(engineKindFacetLabel('civil')).toBe('Гражданский');
  });
});

// Гейт заведения (промты КАРМАНА #36 + #37): новый двигатель нельзя сохранить без вида.
describe('engineKindRequirement', () => {
  it('договор выбран — вид берётся из него, оператора не спрашиваем', () => {
    expect(engineKindRequirement({ contractKind: 'military' })).toEqual({
      ok: true,
      kind: 'military',
      source: 'contract',
    });
  });

  it('договора нет — вид оператор ставит руками', () => {
    expect(engineKindRequirement({ cardKind: 'civil' })).toEqual({ ok: true, kind: 'civil', source: 'card' });
  });

  it('ни договора, ни ручного вида — запись отклоняется с понятным текстом', () => {
    const r = engineKindRequirement({});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe(ENGINE_KIND_REQUIRED_MESSAGE);
    expect(r.ok === false && r.error).toContain('ГОЗ');
  });

  it('пустые значения — это «вида нет», а не вид', () => {
    expect(engineKindRequirement({ contractKind: '', cardKind: '' }).ok).toBe(false);
    expect(engineKindRequirement({ contractKind: null, cardKind: null }).ok).toBe(false);
    expect(engineKindRequirement(null).ok).toBe(false);
  });

  it('вид заказчика гейтом НЕ принимается: при заведении вид выбирает оператор', () => {
    // Третий источник приоритета (вид заказчика по умолчанию) — для показа, но не для
    // заведения: иначе «принудительно попросить поставить вид» означало бы «и так сойдёт».
    expect(engineKindRequirement({ counterpartyKind: 'military' } as EngineKindRequirementSources).ok).toBe(false);
  });

  it('договор важнее ручного значения: спорный ручной вид не мешает заведению', () => {
    expect(engineKindRequirement({ contractKind: 'military', cardKind: 'civil' })).toEqual({
      ok: true,
      kind: 'military',
      source: 'contract',
    });
  });
});

/**
 * Промт КАРМАНА #147: отбор заказчиков по виду договора — фильтр подсказок поля
 * «Контрагент». Это ДРУГОЕ правило, не гейт заведения: гейт вид заказчика не принимает.
 */
describe('отбор заказчиков по виду договора (промт #147)', () => {
  const rows = [
    { id: 'goz', engineKind: 'military' as const },
    { id: 'civil', engineKind: 'civil' as const },
    { id: 'none', engineKind: null as const },
    { id: 'no-field', engineKind: undefined as const },
  ];
  const ids = (list: Array<{ id: string }>) => list.map((r) => r.id);

  it('в ГОЗ-договоре гражданский заказчик не предлагается, ГОЗ — предлагается', () => {
    expect(ids(filterCounterpartiesByContractKind(rows, 'military'))).toEqual(['goz', 'none', 'no-field']);
  });

  it('в гражданском договоре ГОЗ-заказчик не предлагается, гражданский — предлагается', () => {
    expect(ids(filterCounterpartiesByContractKind(rows, 'civil'))).toEqual(['civil', 'none', 'no-field']);
  });

  it('заказчик без вида предлагается ВСЕГДА — иначе поле было бы пустым', () => {
    // На живых данных 25.11.2026 вида не заполнено у 59 заказчиков из 61, и вида «ГОЗ»
    // нет ни у кого: прямой «вид равен» оставил бы оператора с пустым полем «Контрагент»
    // в каждом ГОЗ-договоре. Поэтому «без вида» — своя группа, а не «прятать».
    expect(ids(filterCounterpartiesByContractKind(rows, 'military'))).toContain('none');
    expect(ids(filterCounterpartiesByContractKind(rows, 'civil'))).toContain('none');
    expect(counterpartyKindVerdict(null, 'military')).toBe('unassigned');
  });

  it('вид договора неизвестен — отбор выключен, показываются все', () => {
    expect(ids(filterCounterpartiesByContractKind(rows, null))).toEqual(['goz', 'civil', 'none', 'no-field']);
    expect(counterpartyKindVerdict('civil', null)).toBe('off');
  });

  it('выбранный контрагент остаётся в поле, даже если его вид чужой', () => {
    // Иначе смена вида договора выглядела бы как «значение удалено» — а это неправда.
    const visible = filterCounterpartiesByContractKind(rows, 'military', { keepIds: ['civil'] });
    expect(ids(visible)).toEqual(['goz', 'civil', 'none', 'no-field']);
  });

  it('вердикт различает совпадение, отсутствие вида и чужой вид', () => {
    expect(counterpartyKindVerdict('military', 'military')).toBe('match');
    expect(counterpartyKindVerdict('civil', 'military')).toBe('mismatch');
    expect(counterpartyKindVerdict('', 'military')).toBe('unassigned');
    expect(counterpartyKindVerdict('мусор', 'military')).toBe('unassigned');
  });

  it('вид заказчика читается из строгой таблицы тем же разбором, что и вид договора', () => {
    expect(parseCounterpartyKind('military')).toBe('military');
    expect(parseCounterpartyKind('civil')).toBe('civil');
    expect(parseCounterpartyKind(null)).toBeNull();
    expect(parseCounterpartyKind('да')).toBeNull();
  });

  it('подсказка показывает вид заказчика — оператор видит, почему заказчик предложен', () => {
    expect(counterpartyKindHint('military')).toBe('Вид: ГОЗ');
    expect(counterpartyKindHint('civil')).toBe('Вид: Гражданский');
    expect(counterpartyKindHint(null)).toBe('Вид не задан');
  });

  it('текст для оператора объясняет правило и говорит, сколько скрыто', () => {
    expect(counterpartyKindFilterNote({ contractKind: 'military', hiddenCount: 2 })).toContain('«ГОЗ»');
    expect(counterpartyKindFilterNote({ contractKind: 'military', hiddenCount: 2 })).toContain('Скрыто: 2');
    expect(counterpartyKindFilterNote({ contractKind: 'civil', hiddenCount: 0 })).toContain('«Гражданский»');
    expect(counterpartyKindFilterNote({ contractKind: null, hiddenCount: 0 })).toContain('отбор по виду выключен');
  });

  it('отбор подсказок НЕ меняет гейт заведения двигателя', () => {
    // Вид заказчика гейтом не принимается — при заведении вид выбирает оператор.
    expect(engineKindRequirement({ counterpartyKind: 'military' } as EngineKindRequirementSources).ok).toBe(false);
    expect(engineKindRequirement({ contractKind: 'military' }).ok).toBe(true);
  });
});
