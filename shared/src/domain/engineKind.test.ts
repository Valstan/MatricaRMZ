import { describe, expect, it } from 'vitest';

import {
  ENGINE_KIND_NONE_VALUE,
  ENGINE_KIND_SOURCE_LABELS,
  engineKindFacetLabel,
  engineKindFacetValue,
  engineKindLabel,
  resolveEngineKind,
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
