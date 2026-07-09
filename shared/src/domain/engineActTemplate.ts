/**
 * Именованные шаблоны актов по марке двигателя (PR4 плана editable-engine-acts).
 *
 * Аналог universal work-order templates, но ключ — engineBrandId (unique (brand, name)).
 * Шаблон захватывает «шапку» акта — состав комиссии, гриф «Утверждаю» и список пунктов
 * «Состояние при поступлении» (только ярлыки). НЕ захватывает строки деталей — они уже
 * привязаны к марке через PartSpecBrandLink.inCompletenessAct/inDefectAct.
 *
 * Применение к двигателю замещает commission_members / approver_grif / receipt_condition_list
 * (значения пунктов состояния сохраняются по id), не трогая таблицу деталей.
 */

import {
  APPROVER_GRIF_KEY,
  COMMISSION_MEMBERS_KEY,
  RECEIPT_CONDITION_LIST_KEY,
  readApproverGrif,
  readCommissionMembers,
  readConditionItems,
  type RepairChecklistAnswers,
  type RepairChecklistApproverGrif,
  type RepairChecklistCommissionMember,
} from './repairChecklist.js';

/** Один пункт «состояния» в шаблоне — только идентификатор + ярлык (значение всегда пустое). */
export type EngineActTemplateConditionItem = { id: string; label: string };

/** Содержимое шаблона акта: шапка (комиссия / гриф / пункты состояния), без строк деталей. */
export type EngineActTemplatePayload = {
  commissionMembers: RepairChecklistCommissionMember[];
  approverGrif: RepairChecklistApproverGrif;
  conditionItems: EngineActTemplateConditionItem[];
};

export type EngineActTemplateDto = {
  id: string;
  engineBrandId: string;
  name: string;
  payload: EngineActTemplatePayload;
  /** ms epoch последней правки. */
  updatedAt: number | null;
  /** Логин последнего редактора. */
  updatedBy: string | null;
};

/** Компактная сводка для списка/пикера. */
export type EngineActTemplateSummary = {
  id: string;
  engineBrandId: string;
  name: string;
  updatedAt: number | null;
};

/** Валидация имени — совпадает с SQL CHECK length(1..100). */
export const ENGINE_ACT_TEMPLATE_NAME_MAX = 100;

export function isValidEngineActTemplateName(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length >= 1 && trimmed.length <= ENGINE_ACT_TEMPLATE_NAME_MAX;
}

/** Пустой payload — дефолт для нормализации/парсинга. */
export function emptyEngineActTemplatePayload(): EngineActTemplatePayload {
  return { commissionMembers: [], approverGrif: {}, conditionItems: [] };
}

/** Снять текущую «шапку» акта двигателя в payload шаблона (для «Сохранить как шаблон марки»). */
export function buildEngineActTemplatePayloadFromAnswers(answers: RepairChecklistAnswers): EngineActTemplatePayload {
  return {
    commissionMembers: readCommissionMembers(answers),
    approverGrif: readApproverGrif(answers),
    conditionItems: readConditionItems(answers).map((c) => ({ id: c.id, label: c.label })),
  };
}

/**
 * Применить шаблон к answers двигателя: замещает комиссию / гриф / список пунктов состояния.
 * Значения пунктов состояния сохраняются по id (шаблон несёт только ярлыки). Таблицу деталей
 * и прочие ответы не трогает. Возвращает новый объект answers (не мутирует вход).
 */
export function applyEngineActTemplate(
  answers: RepairChecklistAnswers,
  payload: EngineActTemplatePayload,
): RepairChecklistAnswers {
  const currentValues = new Map(readConditionItems(answers).map((c) => [c.id, c.value] as const));
  const items = payload.conditionItems.map((ti) => ({ id: ti.id, label: ti.label, value: currentValues.get(ti.id) ?? '' }));
  return {
    ...answers,
    [COMMISSION_MEMBERS_KEY]: { kind: 'commission', members: payload.commissionMembers },
    [APPROVER_GRIF_KEY]: { kind: 'approver', grif: payload.approverGrif },
    [RECEIPT_CONDITION_LIST_KEY]: { kind: 'condition_list', items },
  };
}
