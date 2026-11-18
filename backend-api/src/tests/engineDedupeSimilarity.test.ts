/**
 * Правило «сильно похожих» двигателей (владелец 18.11.2026).
 *
 * Разбор дублей клеил номера кластером по транзитивной близости: на живых данных
 * это давало группы по 1478 РАЗНЫХ двигателей (номера завода идут подряд), и
 * оператору предлагалось слить их в один. Теперь «похожие» — это ПАРЫ с
 * одинаковыми маркой, заказчиком и датой прихода, у которых отличается номер.
 *
 * Примеры ниже — реальные карточки завода (прода, 18.11.2026): номера вида
 * «Т12АТ9059», марки «В-59 УМС», заказчик один, даты прихода заполнены не у
 * всех.
 */
import { describe, expect, it } from 'vitest';

import {
  ENGINE_SIMILAR_MAX_DIFF_FIELDS,
  ENGINE_SIMILAR_MIN_CORE_MATCH,
  diffFieldsOf,
  findSimilarEnginePairs,
  isSameSerialFamily,
  isStronglySimilar,
  serialTail,
  type EngineSimilarityInput,
} from '../services/engineDedupeSimilarity.js';

const card = (over: Partial<EngineSimilarityInput> & { id: string }): EngineSimilarityInput => ({
  engineNumber: '',
  engineBrand: '',
  customerId: '',
  arrivalDate: '',
  ...over,
});

const CUSTOMER = 'dea4a5cd';
const ARRIVAL = '1747256400000';

describe('серийный хвост номера', () => {
  it('хвост — цифры в конце, буквы отбрасываются', () => {
    expect(serialTail('Т12АТ9059')).toBe('9059');
    expect(serialTail('8402037')).toBe('8402037');
    expect(serialTail('без номера')).toBe('');
  });

  it('одна серийная семья: хвост совпал или отличается на 1–2', () => {
    // Перепутали букву — хвост тот же.
    expect(isSameSerialFamily('В12АТ9215', '2В12АТ9215')).toBe(true);
    // Ошибка в цифре.
    expect(isSameSerialFamily('8402037', '8402039')).toBe(true);
    // Перестановка двух цифр.
    expect(isSameSerialFamily('8810333', '8830133')).toBe(true);
    // Соседние номера РАЗНЫХ двигателей — не одна семья.
    expect(isSameSerialFamily('Т12АТ9059', 'Т12АТ9329')).toBe(false);
  });
});

describe('сильно похожая пара', () => {
  it('одинаковые марка, заказчик и дата прихода, отличается номер', () => {
    const a = card({ id: 'a', engineNumber: '8402037', engineBrand: '9Р4-6У2', customerId: CUSTOMER, arrivalDate: ARRIVAL });
    const b = card({ id: 'b', engineNumber: '8402039', engineBrand: '9Р4-6У2', customerId: CUSTOMER, arrivalDate: ARRIVAL });
    expect(isStronglySimilar(a, b)).toBe(true);
    expect(diffFieldsOf(a, b)).toEqual(['номер']);
  });

  it('соседние номера одного заказчика — НЕ похожи (нет даты прихода)', () => {
    // Раньше такие пары и склеивались: у завода сотни двигателей одной марки и
    // одного заказчика, номера идут подряд.
    const a = card({ id: 'a', engineNumber: 'Т12АТ9059', engineBrand: 'В-59 УМС', customerId: CUSTOMER });
    const b = card({ id: 'b', engineNumber: 'Т12АТ9329', engineBrand: 'В-59 УМС', customerId: CUSTOMER });
    expect(isStronglySimilar(a, b)).toBe(false);
  });

  it('одна марка и один заказчик, но дата прихода разная — не похожи', () => {
    const a = card({ id: 'a', engineNumber: 'Т12АТ9059', engineBrand: 'В-59 УМС', customerId: CUSTOMER, arrivalDate: ARRIVAL });
    const b = card({ id: 'b', engineNumber: 'Т12АТ9058', engineBrand: 'В-59 УМС', customerId: CUSTOMER, arrivalDate: '1750000000000' });
    expect(isStronglySimilar(a, b)).toBe(false);
  });

  it('различаться могут не больше двух полей', () => {
    expect(ENGINE_SIMILAR_MAX_DIFF_FIELDS).toBe(2);
    expect(ENGINE_SIMILAR_MIN_CORE_MATCH).toBe(2);
    // Различаются номер и марка — два поля, ещё можно.
    const a = card({ id: 'a', engineNumber: '2Х03КТ4702', engineBrand: 'Д12А-525А', customerId: CUSTOMER, arrivalDate: ARRIVAL });
    const b = card({ id: 'b', engineNumber: '2Х03КТ4703', engineBrand: 'Д12А-525Б', customerId: CUSTOMER, arrivalDate: ARRIVAL });
    expect(diffFieldsOf(a, b)).toEqual(['марка', 'номер']);
    expect(isStronglySimilar(a, b)).toBe(true);
  });
});

describe('подбор пар на списке двигателей', () => {
  it('не собирает цепочку в одну группу: пара — пара', () => {
    // Цепочка a~b~c: транзитивно они «похожи» все, но в группу попасть не должны.
    const engines: EngineSimilarityInput[] = [
      card({ id: 'a', engineNumber: 'Т11АТ5068', engineBrand: 'В-59 УМС', customerId: CUSTOMER, arrivalDate: ARRIVAL }),
      card({ id: 'b', engineNumber: 'Т11АТ5069', engineBrand: 'В-59 УМС', customerId: CUSTOMER, arrivalDate: ARRIVAL }),
      card({ id: 'c', engineNumber: 'Т11АТ5070', engineBrand: 'В-59 УМС', customerId: CUSTOMER, arrivalDate: ARRIVAL }),
    ];
    const res = findSimilarEnginePairs(engines);
    for (const pair of res.pairs) {
      expect(pair.a.id).not.toBe(pair.b.id);
      expect(pair.a.engineNumber).not.toBe(pair.b.engineNumber);
    }
    // Каждый двигатель — максимум в одной паре.
    const used = res.pairs.flatMap((p) => [p.a.id, p.b.id]);
    expect(new Set(used).size).toBe(used.length);
    // Группы-точки (склеенные кластеры) не появляются: движков в паре всегда два.
    expect(res.pairs.every((p) => p.a.id && p.b.id)).toBe(true);
  });

  it('одинаковый номер — это не «похожие», а точные дубли (их ловит режим «По номеру»)', () => {
    const engines: EngineSimilarityInput[] = [
      card({ id: 'a', engineNumber: '1234567', engineBrand: 'В-59 УМС', customerId: CUSTOMER, arrivalDate: ARRIVAL }),
      card({ id: 'b', engineNumber: '1234567', engineBrand: 'В-59 УМС', customerId: CUSTOMER, arrivalDate: ARRIVAL }),
    ];
    const res = findSimilarEnginePairs(engines);
    expect(res.pairs).toHaveLength(0);
  });

  it('список ограничен потолком, и обрезка помечена', () => {
    const engines: EngineSimilarityInput[] = [];
    for (let i = 0; i < 120; i += 1) {
      const tail = String(100000 + i * 10);
      engines.push(
        card({ id: `a${i}`, engineNumber: `Т${tail}`, engineBrand: 'В-59 УМС', customerId: CUSTOMER, arrivalDate: ARRIVAL }),
        card({ id: `b${i}`, engineNumber: `Т${String(100001 + i * 10)}`, engineBrand: 'В-59 УМС', customerId: CUSTOMER, arrivalDate: ARRIVAL }),
      );
    }
    const res = findSimilarEnginePairs(engines, { limit: 10 });
    expect(res.pairs.length).toBeLessThanOrEqual(10);
    expect(res.truncated).toBe(true);
    expect(res.totalPairs).toBeGreaterThan(res.pairs.length);
  });

  it('двигатели без номера в разбор не попадают', () => {
    const res = findSimilarEnginePairs([
      card({ id: 'a', engineBrand: 'В-59 УМС', customerId: CUSTOMER, arrivalDate: ARRIVAL }),
      card({ id: 'b', engineBrand: 'В-59 УМС', customerId: CUSTOMER, arrivalDate: ARRIVAL }),
    ]);
    expect(res.pairs).toHaveLength(0);
  });
});
