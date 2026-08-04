import {
  buildAssemblyDuplicateMessage,
  formatAssemblyWorkOrderRef,
  isAssemblyWorkOrderBlocking,
  type AssemblyEngineWorkOrderRef,
} from '@matricarmz/shared';

/**
 * Гейт дублей сборочных нарядов: на один двигатель — один действующий наряд на сборку.
 * Обе точки входа (ПКМ «Наряд на сборку» в списке двигателей и пикер двигателя в шапке
 * карточки) спрашивают гейт ДО создания/применения — сообщение оператор видит вместо
 * пустой карточки, а не после того, как наряд уже заведён.
 */
export type AssemblyDuplicateDecision =
  | { action: 'proceed' }
  | { action: 'cancel' }
  | { action: 'open'; workOrderId: string };

type PickChoice = (opts: {
  title: string;
  detail?: string;
  choices: Array<{ id: string; label: string }>;
}) => Promise<string | null>;

/**
 * Как двигатель называется в сообщении: «Д6 12345 (41/26)». Имена полей у списка двигателей
 * (`engineBrand`/`internalNumberFull`) и у списка карточки наряда (`engineBrandName`/
 * `engineInternalNumber`) разные — берём то, что есть, чтобы обе точки входа звали одинаково.
 */
export function formatEngineGateLabel(engine: {
  engineBrand?: string | null;
  engineBrandName?: string | null;
  engineNumber?: string | null;
  internalNumberFull?: string | null;
  engineInternalNumber?: string | null;
}): string {
  const head = [engine.engineBrandName ?? engine.engineBrand, engine.engineNumber]
    .map((part) => String(part ?? '').trim())
    .filter(Boolean)
    .join(' ');
  const internal = String(engine.engineInternalNumber ?? engine.internalNumberFull ?? '').trim();
  if (!head && !internal) return '';
  return internal ? `${head || 'без номера'} (${internal})` : head;
}

export async function checkAssemblyDuplicate(args: {
  engineId: string;
  engineLabel: string;
  /** Сам редактируемый наряд — он не блокирует смену двигателя внутри себя. */
  excludeId?: string;
  pickChoice: PickChoice;
}): Promise<AssemblyDuplicateDecision> {
  const engineId = String(args.engineId ?? '').trim();
  if (!engineId) return { action: 'proceed' };

  let rows: AssemblyEngineWorkOrderRef[];
  try {
    const res = await window.matrica.workOrders.assemblyForEngine({
      engineId,
      ...(args.excludeId ? { excludeId: args.excludeId } : {}),
    });
    if (!res.ok) return await confirmUnchecked(args.pickChoice, res.error);
    rows = res.rows;
  } catch (e) {
    // Непрочитанная реплика — не доказательство отсутствия наряда, но и запрещать работу
    // по ошибке чтения нельзя: показываем как есть и оставляем решение оператору.
    return await confirmUnchecked(args.pickChoice, String(e ?? ''));
  }

  const message = buildAssemblyDuplicateMessage({ engineLabel: args.engineLabel, refs: rows });
  if (!message) return { action: 'proceed' };

  const blocking = rows.filter(isAssemblyWorkOrderBlocking);
  const openable = (blocking.length > 0 ? blocking : rows).slice(0, 3);
  const choices = [
    ...(message.blocking ? [] : [{ id: 'create', label: 'Всё равно создать новый' }]),
    ...openable.map((ref) => ({ id: `open:${ref.id}`, label: `Открыть наряд ${formatAssemblyWorkOrderRef(ref)}` })),
  ];

  const picked = await args.pickChoice({
    title: message.blocking ? 'Наряд на сборку уже есть' : 'Двигатель уже собирали',
    detail: message.text,
    choices,
  });
  if (!picked) return { action: 'cancel' };
  if (picked === 'create') return { action: 'proceed' };
  if (picked.startsWith('open:')) return { action: 'open', workOrderId: picked.slice('open:'.length) };
  return { action: 'cancel' };
}

async function confirmUnchecked(pickChoice: PickChoice, error: string): Promise<AssemblyDuplicateDecision> {
  const picked = await pickChoice({
    title: 'Проверка дублей не выполнена',
    detail: `Не удалось проверить, есть ли на этот двигатель наряд на сборку: ${error}`,
    choices: [{ id: 'create', label: 'Всё равно продолжить' }],
  });
  return picked === 'create' ? { action: 'proceed' } : { action: 'cancel' };
}
