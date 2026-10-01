import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Порядок полей вкладки «Основное» (владелец 01.10.2026): накладная прихода — сразу под
// датой прихода, накладная отгрузки — сразу за датой отгрузки.
//
// Ассерты держат СВОЙСТВА, а не написание, потому что здесь легко «починить» порядок
// в одном месте и сломать в другом:
//
//  * `orderFieldsByDefs` сортирует поля по `sortOrder` из `attribute_defs`, а
//    `persistFieldOrder` перезаписывает их по ПОРЯДКУ массива `desired`. Значит порядок
//    вкладки определяет `desired`, и `f.order` из shared для уже заведённого поля мёртв;
//  * накладные вынуты из общего разворота плоских полей и вставлены по местам — иначе
//    общий разворот снова утащит их вниз, и правка будет «работать ровно до первого
//    сохранения порядка»;
//  * блок статусов разрезан пополам с двумя накладными, но нумерация sortOrder сквозная:
//    сдвиг второй половины без смещения дал бы двум разным статусам один sortOrder, и
//    сортировка зависла бы от алфавита кода.

function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
}

const CARD = src('./EngineDetailsPage.tsx');



describe('вкладка «Основное»: накладные стоят у своих дат', () => {
  /** Блок `desired` целиком: в нём порядок и есть. */
  function desiredBlock(): string {
    const at = CARD.indexOf('const desired = [');
    expect(at).toBeGreaterThan(-1);
    return CARD.slice(at, CARD.indexOf('\n    ];', at));
  }

  it('налкладная прихода идёт сразу после даты прихода', () => {
    const block = desiredBlock();
    const arrival = block.indexOf("{ code: 'arrival_date', name: 'Дата прихода'");
    const invoice = block.indexOf("...flatFieldDefs(['arrival_invoice'])");
    expect(arrival).toBeGreaterThan(-1);
    expect(invoice).toBeGreaterThan(arrival);
    // Между датой прихода и накладной не должно быть ни одного другого элемента desired:
    // иначе накладная встанет не «под» датой, а через поле.
    const afterArrival = block.indexOf('}', arrival) + 1;
    expect(block.slice(afterArrival, invoice)).not.toMatch(/\{\s*code:/);
  });

  it('налкладная отгрузки стоит между двумя половинами статусов', () => {
    // Код статуса в desired не написан текстом (его даёт statusDefs), поэтому проверяем
    // саму конструкцию: первая половина статусов → накладная отгрузки → вторая половина.
    // Именно эта последовательность и ставит накладную сразу за датой отгрузки.
    const block = desiredBlock();
    const firstHalf = block.indexOf('...statusDefs(STATUS_DISPLAY_ORDER.slice(0, SHIPMENT_SPLIT))');
    const invoice = block.indexOf("...flatFieldDefs(['shipment_invoice'])");
    const secondHalf = block.indexOf('...statusDefs(STATUS_DISPLAY_ORDER.slice(SHIPMENT_SPLIT), SHIPMENT_SPLIT)');
    expect(firstHalf).toBeGreaterThan(-1);
    expect(invoice).toBeGreaterThan(firstHalf);
    expect(secondHalf).toBeGreaterThan(invoice);
  });

  it('налкладные не возвращаются в общий разворот плоских полей', () => {
    // Иначе `...flatFieldDefs(...)` в конце снова поставит их ниже всех дат.
    const tail = desiredBlock().slice(desiredBlock().indexOf('...flatFieldDefs(ENGINE_FLAT_FIELDS'));
    expect(tail).toContain('!MAIN_FIELD_EXTRA_ORDER.includes(code)');
    for (const code of ['arrival_invoice', 'shipment_invoice']) {
      expect(tail.split(code).length - 1, `${code} не должен повторяться в хвосте desired`).toBe(0);
    }
  });

  it('поля рендера берут тот же порядок, что и регистрация дефов', () => {
    // mainFieldItems — то, что видно; desired — то, что записано. Расхождение между ними
    // проявилось бы только на карточке, созданной до правки.
    expect(CARD).toContain('MAIN_FIELD_EXTRA_DEFAULT_ORDER: Record<string, number> = { arrival_invoice: 51, shipment_invoice: 56 }');
    const items = CARD.slice(CARD.indexOf('const mainFieldItems = ['));
    expect(items).toContain('...MAIN_FIELD_EXTRA_ORDER.map((code) => ({');
    expect(items).toContain('defaultOrder: MAIN_FIELD_EXTRA_DEFAULT_ORDER[code]');
    expect(items).toContain('ENGINE_EXTRA_MAIN_FIELDS.filter((f) => !MAIN_FIELD_EXTRA_ORDER.includes(f.code))');
  });

  it('разрез статусов сквозной: вторая половина не начинает с тех же sortOrder', () => {
    // SHIPMENT_SPLIT режет STATUS_DISPLAY_ORDER; смещение обязано идти в statusDefs,
    // иначе флаги первой и второй половины получат одинаковый sortOrder 60/61/…
    expect(CARD).toContain('...statusDefs(STATUS_DISPLAY_ORDER.slice(0, SHIPMENT_SPLIT))');
    expect(CARD).toContain('...statusDefs(STATUS_DISPLAY_ORDER.slice(SHIPMENT_SPLIT), SHIPMENT_SPLIT)');
    const helper = CARD.slice(CARD.indexOf('const statusDefs ='));
    expect(helper).toContain('sortOrder: 60 + (offset + i) * 2');
    expect(helper).toContain('sortOrder: 61 + (offset + i) * 2');
    // Разрез обязан попадать внутрь STATUS_DISPLAY_ORDER, а не мимо его конца.
    const split = Number(CARD.match(/const SHIPMENT_SPLIT = (\d+)/)?.[1]);
    expect(split).toBeGreaterThan(0);
    expect(split).toBeLessThan(CARD.slice(CARD.indexOf('const STATUS_DISPLAY_ORDER'), CARD.indexOf('const STATUS_DISPLAY_ORDER') + 1200).split('\n').length - 2);
  });

  it('дата приёмки заказчиком сдвинута за накладную отгрузки', () => {
    // Шаг «Основное»: порядок рендера задаётся defaultOrder. Накладная отгрузки заняла 56,
    // поэтому приёмка ушла на 57 — иначе поля налезали бы друг на друга при сортировке.
    expect(CARD).toMatch(/code: 'status_customer_accepted',\s+defaultOrder: 57,/);
  });
});