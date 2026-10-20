import {
  PRIMARY_CONTRACT_SECTION_KEY,
  attachEngineToSlot,
  contractSectionAddonToken,
  parseContractSections,
  planSlotForEngine,
} from '@matricarmz/shared';

import { mutateContractPayments } from './contractPaymentsStore.js';

/**
 * Посадить двигатель в слот ЕГО марки внутри выбранного договора.
 *
 * Марка известна вызывающему, а слоты живут в договоре — раньше привязка из карточки
 * двигателя слот не создавала вовсе: он назначался, только когда кто-нибудь откроет
 * карточку договора, и до 31.07 мог достаться слоту чужой марки.
 *
 * С 10.2026 у привязки два входа — карточка двигателя и пакетный приём списком, —
 * поэтому логика вынесена сюда: две копии разошлись бы, и один из входов тихо
 * перестал бы занимать плановое место (двигатель есть, денег под него нет).
 *
 * Возвращает выбранную секцию (её пишем в `contract_section_number`) и признак
 * «сверх плана» — о нём говорим оператору вслух.
 */
export async function placeEngineIntoContractSlot(args: {
  contractId: string;
  engineId: string;
  engineBrandId?: string;
  preferredSectionKey?: string;
  /** Куда сказать про неназначенный слот (карточка пишет в свою строку статуса). */
  onStatus?: (message: string) => void;
}): Promise<{ sectionKey: string; overPlan: boolean } | null> {
  const targetContractId = String(args.contractId ?? '').trim();
  if (!targetContractId) return null;
  const engineBrandId = String(args.engineBrandId ?? '').trim();
  try {
    const contract = (await window.matrica.admin.entities.get(targetContractId)) as {
      attributes?: Record<string, unknown>;
    } | null;
    const committed = parseContractSections(contract?.attributes ?? {});
    const sectionKeys = [
      PRIMARY_CONTRACT_SECTION_KEY,
      ...committed.addons.map((addon) => contractSectionAddonToken(addon.seq)),
    ];
    let placed: { sectionKey: string; overPlan: boolean } | null = null;
    const r = await mutateContractPayments(targetContractId, (current) => {
      const placement = planSlotForEngine({
        cp: current,
        sectionKeys,
        ...(engineBrandId ? { engineBrandId } : {}),
        ...(args.preferredSectionKey ? { preferredSectionKey: args.preferredSectionKey } : {}),
      });
      placed = { sectionKey: placement.sectionKey, overPlan: placement.overPlan };
      return attachEngineToSlot(
        current,
        placement,
        args.engineId,
        () => crypto.randomUUID(),
        engineBrandId || undefined,
      );
    });
    if (!r.ok) {
      args.onStatus?.(`Ошибка платежей договора: ${r.error}`);
      return null;
    }
    return placed;
  } catch (e) {
    // Карточку двигателя из-за платежей не валим: связь двигатель↔договор всё равно
    // запишется, а слот доназначится при открытии карточки договора.
    args.onStatus?.(`Слот в договоре не назначен: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}
