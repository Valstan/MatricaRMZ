import {
  buildShipmentOpenAssemblyMessage,
  formatAssemblyWorkOrderRef,
  type AssemblyEngineWorkOrderRef,
} from '@matricarmz/shared';

/**
 * Гейт отгрузки: галка «Отправлен заказчику» при незакрытом сборочном наряде.
 * Спрашивается ДО изменения локального state карточки двигателя: на отмену галка
 * не встаёт вовсе. На подтверждение наряды закрываются штатным backend-путём
 * (sync.run → workOrders.close, closedTs = сейчас = «сегодняшнее число»).
 */
export type ShipmentAssemblyDecision =
  | { action: 'proceed'; closedWorkOrders: number }
  | { action: 'cancel' };

type PickChoice = (opts: {
  title: string;
  detail?: string;
  choices: Array<{ id: string; label: string }>;
}) => Promise<string | null>;

export async function confirmShipmentWithOpenAssembly(args: {
  engineId: string;
  engineLabel: string;
  pickChoice: PickChoice;
}): Promise<ShipmentAssemblyDecision> {
  const engineId = String(args.engineId ?? '').trim();
  if (!engineId) return { action: 'proceed', closedWorkOrders: 0 };

  let rows: AssemblyEngineWorkOrderRef[];
  try {
    const res = await window.matrica.workOrders.assemblyForEngine({ engineId });
    if (!res.ok) return await confirmUnchecked(args.pickChoice, res.error);
    rows = res.rows;
  } catch (e) {
    // Непрочитанная реплика — не доказательство отсутствия наряда, но и запрещать
    // отгрузку по ошибке чтения нельзя: показываем как есть, решает оператор.
    return await confirmUnchecked(args.pickChoice, String(e ?? ''));
  }

  const message = buildShipmentOpenAssemblyMessage({ engineLabel: args.engineLabel, refs: rows });
  if (!message) return { action: 'proceed', closedWorkOrders: 0 };

  const picked = await args.pickChoice({
    title: message.refs.length === 1 ? 'Наряд на сборку не закрыт' : 'Наряды на сборку не закрыты',
    detail: message.text,
    choices: [{ id: 'close', label: message.refs.length === 1 ? 'Закрыть наряд' : 'Закрыть наряды' }],
  });
  if (picked !== 'close') return { action: 'cancel' };

  let closedCount = 0;
  for (const ref of message.refs) {
    // Force-push локального payload в backend Postgres перед close: его close-логика
    // читает op.metaJson.workOrderKind, который мог не доехать периодическим sync.
    // workOrders.update здесь запрещён — он безусловно возвращает наряд в draft.
    try {
      await window.matrica.sync.run();
    } catch {
      // Сбой sync не фатален: close сам скажет, если backend наряд не видит.
    }
    let error = '';
    try {
      const closed = await window.matrica.workOrders.close({ operationId: ref.id });
      if (closed.ok) {
        closedCount += 1;
        continue;
      }
      error = closed.error;
    } catch (e) {
      error = String(e ?? '');
    }
    await showCloseError(args.pickChoice, ref, error);
    return { action: 'cancel' };
  }
  return { action: 'proceed', closedWorkOrders: closedCount };
}

async function confirmUnchecked(pickChoice: PickChoice, error: string): Promise<ShipmentAssemblyDecision> {
  const picked = await pickChoice({
    title: 'Проверка нарядов не выполнена',
    detail: `Не удалось проверить, закрыт ли наряд на сборку этого двигателя: ${error}`,
    choices: [{ id: 'proceed', label: 'Всё равно отметить отгрузку' }],
  });
  return picked === 'proceed' ? { action: 'proceed', closedWorkOrders: 0 } : { action: 'cancel' };
}

/** Строгий блок (data integrity > convenience): ошибка закрытия ⇒ галка не встаёт. */
async function showCloseError(pickChoice: PickChoice, ref: AssemblyEngineWorkOrderRef, error: string): Promise<void> {
  const detail = error.startsWith('permission denied')
    ? `Нет права закрыть наряд ${formatAssemblyWorkOrderRef(ref)} (требуется право «Закрытие нарядов»). Отметка «Отправлен заказчику» не установлена — обратитесь к пользователю с правом закрытия нарядов.`
    : `Не удалось закрыть наряд ${formatAssemblyWorkOrderRef(ref)}: ${error}\nОтметка «Отправлен заказчику» не установлена.`;
  await pickChoice({
    title: 'Наряд не закрыт',
    detail,
    choices: [{ id: 'ok', label: 'Понятно' }],
  });
}
