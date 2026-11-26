/**
 * Разрезы группировки списка двигателей — **один список** для страницы и для сторожа.
 *
 * Промт КАРМАНА #164: «Заказчик → договор» остался только на экране — печать, выгрузка и
 * контекстное меню его не знали. Причина была не в местах, а в том, что разрезы держались в
 * странице (`EnginesPage.tsx`), а печать и выгрузка получали плоский отсортированный список.
 * Теперь разрезы объявлены здесь, и по этому же списку сторож проверяет, что новый разрез
 * доехал до печати, выгрузки и меню.
 *
 * Список не пустой «на будущее»: пока в нём ровно те разрезы, что были в странице, —
 * «Переезд» ничего не меняет, но список становится проверяемым.
 */
import type { EngineListItem } from '../ipc/types.js';
import { engineFactoryStage, type EngineFactoryStageTypeRef } from './engineFactoryStage.js';
import type { GroupLevel } from './listGrouping.js';
import type { RepairStageTemplate } from './repairStages.js';

export type EngineListGroupBy = 'stage' | 'customer' | 'customer_stage' | 'contract' | 'customer_contract' | 'none';

export const ENGINE_LIST_GROUP_BY_LABELS: Record<EngineListGroupBy, string> = {
  stage: 'По этапу на заводе',
  customer: 'По заказчику',
  customer_stage: 'Заказчик → этап',
  contract: 'По договору',
  customer_contract: 'Заказчик → договор',
  none: 'Без группировки',
};

/** Разрезы, которые действительно раскладывают список по группам (без «Без группировки»). */
export const ENGINE_LIST_GROUP_BY_CUTS: EngineListGroupBy[] = [
  'stage',
  'customer',
  'customer_stage',
  'contract',
  'customer_contract',
];

export type EngineListGroupDeps = {
  /** Справочник видов работ — для этапа на заводе. */
  sheetTypes?: readonly EngineFactoryStageTypeRef[];
  /** Шаблоны этапов ремонта — для этапа на заводе. */
  stageTemplates?: readonly RepairStageTemplate[];
};

/**
 * Уровни группировки по разрезу. Пустой ряд — список плоский.
 *
 * Подписи и ключи те же, что были в странице: этап несёт ранг из `engineFactoryStage`
 * (порядок групп), заказчик — по подписи, договор — по номеру (`contractName` = атрибут
 * `number` договора; своего названия у договора нет). Двигатели без договора — отдельная
 * группа «Без договора», не «прочие».
 */
export function engineListGroupLevels(
  groupBy: EngineListGroupBy,
  deps: EngineListGroupDeps = {},
): GroupLevel<EngineListItem>[] {
  const byStage: GroupLevel<EngineListItem> = {
    keyOf: (e) => {
      const s = engineFactoryStage(e, deps.sheetTypes, deps.stageTemplates);
      return { key: s.key, label: s.label, rank: s.rank };
    },
  };
  const byCustomer: GroupLevel<EngineListItem> = {
    keyOf: (e) => {
      const label = String(e.customerName ?? '').trim();
      return { key: String(e.customerId ?? '').trim() || `name:${label.toLowerCase()}` || 'none', label: label || 'Без заказчика' };
    },
  };
  // Группировка по договору (промт КАРМАНА #105): ключ — договор карточки (`contractId`),
  // подпись — его НОМЕР. ДС (дополнительное соглашение) — отдельный атрибут карточки
  // (`contractSectionNumber`), договор остаётся основным ⇒ ДС сливается со своим договором.
  const byContract: GroupLevel<EngineListItem> = {
    keyOf: (e) => {
      const label = String(e.contractName ?? '').trim();
      const id = String(e.contractId ?? '').trim();
      return { key: id || `name:${label.toLowerCase()}`, label: label || 'Без договора' };
    },
  };
  switch (groupBy) {
    case 'stage':
      return [byStage];
    case 'customer':
      return [byCustomer];
    case 'customer_stage':
      return [byCustomer, byStage];
    case 'contract':
      return [byContract];
    case 'customer_contract':
      return [byCustomer, byContract];
    default:
      return [];
  }
}
