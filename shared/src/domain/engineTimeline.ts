/**
 * Паспорт ремонта двигателя — нормализация ленты событий (brain-бэклог #1,
 * from-brain/2026-06-04-feature-backlog-traceability-costing-qr.md).
 *
 * Источник — строки `operations` по двигателю (уже синкаются на всех клиентов,
 * запермичены `operations.view`, наполняются приёмкой/дефектовкой/актами/
 * межцеховыми передачами/статусами деталей/ремфондом). Новой таблицы НЕ требуется —
 * этот модуль лишь превращает разнородные `operationType` в типизированную
 * хронологическую ленту с человеческими подписями и иконкой для UI-таймлайна.
 *
 * Read-only слой отображения: сортировка по `performedAt` (fallback `updatedAt`),
 * подписи из единого реестра, порядок фаз для группировки. Без записи и без схемы.
 */

/** Минимальный вход — форма строки `operations` (OperationItem), без завязки на ipc/types. */
export type EngineTimelineSourceRow = {
  id: string;
  operationType: string;
  status: string;
  note: string | null;
  performedAt: number | null;
  performedBy: string | null;
  metaJson: string | null;
  createdAt: number;
  updatedAt: number;
};

/** Фаза жизненного цикла — грубый порядок для группировки/прогресса. */
export type EngineLifecyclePhase =
  | 'acceptance'
  | 'defect'
  | 'disassembly'
  | 'repair'
  | 'assembly'
  | 'test'
  | 'shipment'
  | 'other';

export type OperationDescriptor = {
  /** Человеческая подпись типа события. */
  label: string;
  /** Эмодзи-иконка для карточки таймлайна (без внешних зависимостей). */
  icon: string;
  /** Фаза жизненного цикла — для группировки и порядка. */
  phase: EngineLifecyclePhase;
};

/** Порядок фаз в таймлайне (по возрастанию — от приёмки к отгрузке). */
export const ENGINE_LIFECYCLE_PHASE_ORDER: Record<EngineLifecyclePhase, number> = {
  acceptance: 10,
  defect: 20,
  disassembly: 30,
  repair: 40,
  assembly: 50,
  test: 70,
  shipment: 90,
  other: 60,
};

/**
 * Реестр подписей типов операций. Покрывает и enum OperationTypeCode, и типы-носители
 * из domain (акты, статусы деталей, ремфонд). Неизвестный тип → generic-дескриптор.
 */
const OPERATION_DESCRIPTORS: Record<string, OperationDescriptor> = {
  acceptance: { label: 'Приёмка', icon: '📥', phase: 'acceptance' },
  engine_intake: { label: 'Первичный ввод двигателя', icon: '📥', phase: 'acceptance' },
  kitting: { label: 'Комплектовка', icon: '🧰', phase: 'acceptance' },
  completeness: { label: 'Акт комплектности', icon: '✅', phase: 'acceptance' },
  completeness_act: { label: 'Акт комплектности', icon: '✅', phase: 'acceptance' },
  defect: { label: 'Дефектовка', icon: '🔍', phase: 'defect' },
  defect_act: { label: 'Акт дефектовки', icon: '🔍', phase: 'defect' },
  engine_inventory: { label: 'Ведомость деталей', icon: '📋', phase: 'defect' },
  claim_act: { label: 'Акт рекламации', icon: '⚠️', phase: 'defect' },
  disassembly: { label: 'Разборка', icon: '🔧', phase: 'disassembly' },
  repair: { label: 'Ремонт', icon: '🛠️', phase: 'repair' },
  work_order: { label: 'Наряд', icon: '📝', phase: 'repair' },
  part_status_event: { label: 'Статус детали', icon: '⚙️', phase: 'repair' },
  repair_fund_instance: { label: 'Ремфонд — экземпляр', icon: '📦', phase: 'repair' },
  repair_fund_requirement: { label: 'Ремфонд — потребность', icon: '📋', phase: 'repair' },
  supply_request: { label: 'Заявка в снабжение', icon: '🧾', phase: 'repair' },
  otk: { label: 'ОТК', icon: '🔎', phase: 'test' },
  test: { label: 'Испытания', icon: '🧪', phase: 'test' },
  packaging: { label: 'Упаковка', icon: '📦', phase: 'shipment' },
  workshop_transfer: { label: 'Межцеховая передача', icon: '🔁', phase: 'other' },
  tool_movement: { label: 'Движение инструмента', icon: '🔩', phase: 'other' },
  stock_receipt: { label: 'Приход на склад', icon: '⬆️', phase: 'other' },
  stock_issue: { label: 'Расход со склада', icon: '⬇️', phase: 'other' },
  stock_transfer: { label: 'Перемещение склада', icon: '↔️', phase: 'other' },
  shipment: { label: 'Отгрузка', icon: '🚚', phase: 'shipment' },
  customer_delivery: { label: 'Доставка заказчику', icon: '🏁', phase: 'shipment' },
};

const GENERIC_DESCRIPTOR: OperationDescriptor = { label: '', icon: '•', phase: 'other' };

/** Дескриптор типа операции (подпись/иконка/фаза). Неизвестный тип → generic с сырым кодом. */
export function describeOperationType(operationType: string): OperationDescriptor {
  const hit = OPERATION_DESCRIPTORS[operationType];
  if (hit) return hit;
  return { ...GENERIC_DESCRIPTOR, label: operationType || '—' };
}

/** Подписи статусов операций (общие коды workflow + сырой код как fallback). */
const OPERATION_STATUS_LABELS: Record<string, string> = {
  draft: 'Черновик',
  signed: 'Подписан',
  transferred: 'Передан',
  in_repair: 'В ремонте',
  ready_for_assembly: 'Готов к сборке',
  done: 'Выполнено',
  closed: 'Закрыто',
  open: 'Открыто',
  accepted: 'Принято',
  shipped: 'Отгружено',
};

export function operationStatusLabel(status: string): string {
  return OPERATION_STATUS_LABELS[status] ?? status ?? '';
}

/** Одна карточка ленты — нормализованное событие для рендера. */
export type EngineTimelineItem = {
  id: string;
  operationType: string;
  label: string;
  icon: string;
  phase: EngineLifecyclePhase;
  statusLabel: string;
  note: string | null;
  performedBy: string | null;
  /** Момент события (performedAt, иначе updatedAt) — для отображения и сортировки. */
  at: number;
};

/**
 * Строит хронологическую ленту (новые сверху) из строк `operations`. Каждое событие
 * нормализуется через реестр подписей; момент — `performedAt`, иначе `updatedAt`.
 */
export function buildEngineTimeline(rows: ReadonlyArray<EngineTimelineSourceRow>): EngineTimelineItem[] {
  const items = rows.map((row): EngineTimelineItem => {
    const d = describeOperationType(row.operationType);
    return {
      id: row.id,
      operationType: row.operationType,
      label: d.label,
      icon: d.icon,
      phase: d.phase,
      statusLabel: operationStatusLabel(row.status),
      note: row.note,
      performedBy: row.performedBy,
      at: row.performedAt ?? row.updatedAt,
    };
  });
  items.sort((a, b) => b.at - a.at);
  return items;
}
