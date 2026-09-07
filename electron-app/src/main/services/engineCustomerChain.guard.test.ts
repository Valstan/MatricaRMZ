import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { resolveEngineCustomer } from '@matricarmz/shared';
import { describe, expect, it } from 'vitest';

// Сторож правила «заказчик двигателя считается из договора» (решение владельца 07.09.2026).
//
// Само правило — чистая `resolveEngineCustomer`, у неё свои тесты. Рвётся не правило, а места,
// где его читают: список двигателей, карточка двигателя, карточка наряда. Каждое из них раньше
// складывало цепочку по-своему, и разошлись они молча — типы сходились, тесты были зелёными,
// а один и тот же двигатель показывал разного заказчика в списке и в отчёте (M111).
function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
}

const ENGINE_SERVICE = src('./engineService.ts');
const ENGINE_CARD = src('../../renderer/src/ui/pages/EngineDetailsPage.tsx');
const WORK_ORDER_CARD = src('../../renderer/src/ui/pages/WorkOrderDetailsPage.tsx');
const REPORTS_CONTEXT = src('./reports/context.ts');

describe('заказчик двигателя считается из договора во всех точках чтения', () => {
  it('список двигателей: строка отдаёт вычисленного заказчика, а не поле карточки', () => {
    expect(ENGINE_SERVICE, 'список снова читает заказчика прямо из карточки').toContain(
      'const resolvedCustomerId = resolveEngineCustomer(',
    );
    expect(ENGINE_SERVICE).toContain('customerId: resolvedCustomerId,');
    expect(ENGINE_SERVICE, 'подпись контрагента должна идти от вычисленного значения').toContain(
      'const customerName = resolvedCustomerId ? customerNameById.get(resolvedCustomerId) : undefined;',
    );
  });

  it('карточка двигателя: при выбранном договоре заказчик показывается вычисленным и не пишется', () => {
    expect(ENGINE_CARD).toContain('const effectiveCustomerId = contractCustomerId || customerId;');
    expect(ENGINE_CARD, 'сохранение снова переписывает карточку договорным значением').toContain(
      'customer_id: contractCustomerId ? asNullableText(props.engine.attributes?.customer_id) : asNullableText(customerId),',
    );
    expect(ENGINE_CARD, 'оператору не сказано, откуда значение — поле выглядит сломанным').toContain(
      'из договора — меняется вместе с ним',
    );
  });

  it('карточка наряда: заказчик берётся общим правилом, а не «карточка первой»', () => {
    expect(WORK_ORDER_CARD).toContain('resolveEngineCustomer(');
    expect(WORK_ORDER_CARD, 'вернулось чтение только легаси-атрибута договора').toContain('parseContractSections(attrs)');
  });

  it('отчёты: тот же общий резолвер, а не своя копия цепочки', () => {
    expect(REPORTS_CONTEXT).toContain('return resolveEngineCustomer(');
  });

  it('правило одно и то же на всех входах — контроль, что сторож проверяет живую функцию', () => {
    const contracts = new Map([['C1', 'CP1']]);
    expect(resolveEngineCustomer({ contractId: 'C1', customerId: 'CP2' }, contracts).id).toBe('CP1');
    expect(resolveEngineCustomer({ customerId: 'CP2' }, contracts).id).toBe('CP2');
  });
});
