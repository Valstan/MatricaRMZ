// Contract sections structure (stored in contract.attributes.contract_sections as JSON).

export type ContractEngineBrandRow = {
  engineBrandId: string;
  qty: number;
  unitPrice: number;
};

export type ContractPartRow = {
  partId: string;
  qty: number;
  unitPrice: number;
};

export type ContractExecutionPartRow = {
  partId: string;
  plannedQty: number;
  completedQty: number;
};

export type ContractPrimarySection = {
  number: string;
  signedAt: number | null;
  dueAt: number | null;
  internalNumber: string;
  customerId: string | null;
  engineBrands: ContractEngineBrandRow[];
  parts: ContractPartRow[];
};

export type ContractAddonSection = {
  number: string;
  /**
   * Стабильный порядковый номер ДС в пределах контракта (1, 2, 3…). Присваивается
   * при создании (`max(seq)+1`), НЕ переиспользуется при удалении — привязки
   * двигателей (`contract_section_number = "ДС {seq}"`) не ломаются. Для легаси-ДС
   * без сохранённого seq парсер подставляет позиционный (idx+1) до первого пересохранения.
   */
  seq: number;
  signedAt: number | null;
  dueAt: number | null;
  /** Когда ДС заведено (ms). null для легаси-ДС → не попадает в напоминание о «новых». */
  createdAt: number | null;
  /** Произвольное примечание оператора к дополнительному соглашению. */
  note: string;
  engineBrands: ContractEngineBrandRow[];
  parts: ContractPartRow[];
};

export type ContractSections = {
  primary: ContractPrimarySection;
  addons: ContractAddonSection[];
};

export const CONTRACT_EXECUTION_PARTS_ATTR_CODE = 'contract_execution_parts';

export const STATUS_CODES = [
  'status_rework_sent',
  'status_scrap_confirmed',
  'status_repair_started',
  'status_repaired',
  'status_customer_sent',
  'status_customer_accepted',
  'status_storage_received',
  'status_rejected',
] as const;

export type StatusCode = (typeof STATUS_CODES)[number];

export const STATUS_DATE_CODES: Record<StatusCode, `${StatusCode}_date`> = {
  status_rework_sent: 'status_rework_sent_date',
  status_scrap_confirmed: 'status_scrap_confirmed_date',
  status_storage_received: 'status_storage_received_date',
  status_repair_started: 'status_repair_started_date',
  status_repaired: 'status_repaired_date',
  status_customer_sent: 'status_customer_sent_date',
  status_customer_accepted: 'status_customer_accepted_date',
  status_rejected: 'status_rejected_date',
};

export function statusDateCode(code: StatusCode): string {
  return STATUS_DATE_CODES[code];
}

export const STATUS_LABELS: Record<StatusCode, string> = {
  // Переоборудован из «Отправлен заказчику на перекомплектацию» (2026-07-15, на проде
  // флаг не использовался — 0 записей). Утиль: двигатель признан неремонтопригодным,
  // после дефектовки собран обратно и возвращён заказчику без ремонта (или с недоремонтом).
  status_rework_sent: 'Утиль — отправлен заказчику',
  // Ранняя метка утиля: ставится по итогам дефектовки, до сборки и отправки. Снимает
  // блокировку выдачи Assembly-наряда по утильным деталям (для утильного двигателя утиль
  // в дефектовке — ожидаемое состояние): его собирают обратно из чего есть, включая утиль.
  status_scrap_confirmed: 'Признан утильным',
  status_storage_received: 'Принят на хранение',
  status_repair_started: 'Начат ремонт',
  status_repaired: 'Отремонтирован',
  status_customer_sent: 'Отправлен заказчику',
  status_customer_accepted: 'Принято заказчиком',
  status_rejected: 'Забракован',
};

export function statusProgressPct(code: StatusCode | null | undefined): number {
  if (!code) return 0;
  switch (code) {
    case 'status_customer_sent':
    case 'status_rejected':
    case 'status_customer_accepted':
    case 'status_rework_sent': // утиль — терминальный исход: двигатель покинул завод
      return 100;
    case 'status_repaired':
      return 70;
    case 'status_repair_started':
      return 40;
    case 'status_storage_received':
      return 20;
    // `status_scrap_confirmed` — 0: судьба двигателя решена, но он ещё на заводе (его
    // собирают перед возвратом). Прогресс закрывает отправка (`status_rework_sent`).
    default:
      return 0;
  }
}

/**
 * Утильный двигатель — признан неремонтопригодным на дефектовке (`status_scrap_confirmed`)
 * либо уже возвращён заказчику как утиль (`status_rework_sent`). Единый источник истины
 * для связки «утиль ⇄ наряд на сборку»: для такого двигателя утильные детали в дефектовке
 * — ожидаемое состояние, поэтому блокировка выдачи Assembly-наряда и авто-отзыв по утилю
 * не применяются (его собирают обратно из чего есть, чтобы вернуть заказчику).
 */
export function isScrapEngine(flags: Partial<Record<StatusCode, boolean>> | null | undefined): boolean {
  if (!flags) return false;
  return flags.status_scrap_confirmed === true || flags.status_rework_sent === true;
}

export function computeObjectProgress(flags: Partial<Record<StatusCode, boolean>>): number {
  let max = 0;
  for (const code of STATUS_CODES) {
    if (flags[code]) {
      const p = statusProgressPct(code);
      if (p > max) max = p;
    }
  }
  return max;
}

/**
 * Взаимоисключение флагов статусов двигателя — единый источник истины для ручного
 * тумблера в карточке (`applyStatusCheckboxChange`) и авто-перехода из наряда сборки.
 * «Начат ремонт» (`status_repair_started`) исключает все остальные; установка любого
 * другого статуса гасит только «Начат ремонт» (остальные могут сосуществовать —
 * напр. «Отремонтирован» + «Отправлен заказчику»). Снятие флага прочие не трогает.
 * Чистая функция: возвращает новую карту флагов, вход не мутирует.
 */
export function applyStatusFlagChange(
  flags: Partial<Record<StatusCode, boolean>>,
  code: StatusCode,
  next: boolean,
): Partial<Record<StatusCode, boolean>> {
  const updated: Partial<Record<StatusCode, boolean>> = { ...flags, [code]: next };
  if (code === 'status_repair_started' && next) {
    for (const c of STATUS_CODES) {
      if (c !== 'status_repair_started') updated[c] = false;
    }
  } else if (code !== 'status_repair_started' && next) {
    updated.status_repair_started = false;
  }
  return updated;
}

/**
 * Ранг статуса по «продвинутости» жизненного цикла двигателя — для guard'а «только
 * вперёд» авто-перехода из наряда сборки (не откатывать более поздний статус назад).
 * `status_rejected` и `status_rework_sent` (утиль) — боковые ветки, в линейный ранг не входят (0).
 */
export const STATUS_ADVANCE_RANK: Record<StatusCode, number> = {
  status_rejected: 0,
  status_rework_sent: 0,
  status_scrap_confirmed: 0,
  status_storage_received: 1,
  status_repair_started: 2,
  status_repaired: 3,
  status_customer_sent: 4,
  status_customer_accepted: 5,
};

export type ProgressLinkedItem = {
  contractId?: string | null;
  statusFlags?: Partial<Record<StatusCode, boolean>> | null;
};

export type ProgressAggregate = {
  shippedCount: number;
  completedCount: number;
  totalCount: number;
  progress01: number | null;
  progressPct: number | null;
};

export type ContractExecutionProgressAggregate = ProgressAggregate & {
  engineAcceptedCount: number;
  enginePlannedCount: number;
  partCompletedCount: number;
  rawPartCompletedCount: number;
  partPlannedCount: number;
};

function normalizeQty(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n;
}

export function contractPlannedItemsCount(sections: ContractSections | null | undefined): number {
  if (!sections) return 0;

  let total = 0;
  const addRows = (rows: Array<{ qty: number }>) => {
    for (const row of rows) total += normalizeQty(row?.qty);
  };

  addRows(sections.primary.engineBrands);
  addRows(sections.primary.parts);
  for (const addon of sections.addons) {
    addRows(addon.engineBrands);
    addRows(addon.parts);
  }

  return total;
}

export function contractPlannedEngineItemsCount(sections: ContractSections | null | undefined): number {
  if (!sections) return 0;

  let total = 0;
  const addRows = (rows: Array<{ qty: number }>) => {
    for (const row of rows) total += normalizeQty(row?.qty);
  };

  addRows(sections.primary.engineBrands);
  for (const addon of sections.addons) addRows(addon.engineBrands);

  return total;
}

export function contractPlannedLegacyPartItemsCount(sections: ContractSections | null | undefined): number {
  if (!sections) return 0;

  let total = 0;
  const addRows = (rows: Array<{ qty: number }>) => {
    for (const row of rows) total += normalizeQty(row?.qty);
  };

  addRows(sections.primary.parts);
  for (const addon of sections.addons) addRows(addon.parts);

  return total;
}

export function normalizeContractExecutionParts(rows: unknown): ContractExecutionPartRow[] {
  if (!Array.isArray(rows)) return [];

  const out: ContractExecutionPartRow[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const item = row as Record<string, unknown>;
    const partId = typeof item.partId === 'string' ? item.partId.trim() : '';
    if (!partId) continue;
    out.push({
      partId,
      plannedQty: normalizeQty(item.plannedQty),
      completedQty: normalizeQty(item.completedQty),
    });
  }
  return out;
}

export function parseContractExecutionParts(attrs: Record<string, unknown> | null | undefined): ContractExecutionPartRow[] {
  if (!attrs || typeof attrs !== 'object') return [];
  return normalizeContractExecutionParts(attrs[CONTRACT_EXECUTION_PARTS_ATTR_CODE]);
}

export function contractExecutionPartsPlannedCount(rows: ContractExecutionPartRow[] | null | undefined): number {
  if (!Array.isArray(rows) || rows.length === 0) return 0;
  let total = 0;
  for (const row of rows) total += normalizeQty(row?.plannedQty);
  return total;
}

export function contractExecutionPartsCompletedCount(
  rows: ContractExecutionPartRow[] | null | undefined,
  opts?: { capByPlan?: boolean },
): number {
  if (!Array.isArray(rows) || rows.length === 0) return 0;
  const capByPlan = opts?.capByPlan !== false;
  let total = 0;
  for (const row of rows) {
    const plannedQty = normalizeQty(row?.plannedQty);
    const completedQty = normalizeQty(row?.completedQty);
    total += capByPlan ? Math.min(plannedQty, completedQty) : completedQty;
  }
  return total;
}

export function aggregateProgressWithPlan(
  items: Array<Pick<ProgressLinkedItem, 'statusFlags'>>,
  plannedTotalCount?: number | null,
): ProgressAggregate {
  let shippedCount = 0;
  for (const item of items) {
    if (item.statusFlags?.status_customer_accepted) shippedCount += 1;
  }

  const hasPlannedTotal = Number.isFinite(plannedTotalCount) && Number(plannedTotalCount) > 0;
  const denominator = hasPlannedTotal ? Number(plannedTotalCount) : items.length;

  return {
    shippedCount,
    completedCount: shippedCount,
    totalCount: denominator,
    progress01: denominator > 0 ? Math.min(1, shippedCount / denominator) : null,
    progressPct: denominator > 0 ? Math.min(100, (shippedCount / denominator) * 100) : null,
  };
}

export function aggregateProgress(items: Array<Pick<ProgressLinkedItem, 'statusFlags'>>): ProgressAggregate {
  return aggregateProgressWithPlan(items, null);
}

export function aggregateProgressByContract(items: ProgressLinkedItem[]): Record<string, ProgressAggregate> {
  const grouped: Record<string, Array<Pick<ProgressLinkedItem, 'statusFlags'>>> = {};
  for (const item of items) {
    const contractId = item.contractId ? String(item.contractId) : '';
    if (!contractId) continue;
    if (!grouped[contractId]) grouped[contractId] = [];
    grouped[contractId].push({ statusFlags: item.statusFlags ?? null });
  }

  const out: Record<string, ProgressAggregate> = {};
  for (const [contractId, group] of Object.entries(grouped)) {
    out[contractId] = aggregateProgress(group);
  }
  return out;
}

export function aggregateContractExecutionProgress(args: {
  sections: ContractSections | null | undefined;
  engineItems: Array<Pick<ProgressLinkedItem, 'statusFlags'>>;
  executionParts: ContractExecutionPartRow[] | null | undefined;
}): ContractExecutionProgressAggregate {
  const engineAcceptedCount = aggregateProgress(args.engineItems).completedCount;
  const enginePlannedCount = contractPlannedEngineItemsCount(args.sections);
  const partPlannedCount = contractExecutionPartsPlannedCount(args.executionParts);
  const rawPartCompletedCount = contractExecutionPartsCompletedCount(args.executionParts, { capByPlan: false });
  const partCompletedCount = contractExecutionPartsCompletedCount(args.executionParts, { capByPlan: true });
  const plannedTotalCount = enginePlannedCount + partPlannedCount;

  if (plannedTotalCount > 0) {
    const completedCount = engineAcceptedCount + (partPlannedCount > 0 ? partCompletedCount : 0);
    return {
      shippedCount: completedCount,
      completedCount,
      totalCount: plannedTotalCount,
      progress01: Math.min(1, completedCount / plannedTotalCount),
      progressPct: Math.min(100, (completedCount / plannedTotalCount) * 100),
      engineAcceptedCount,
      enginePlannedCount,
      partCompletedCount,
      rawPartCompletedCount,
      partPlannedCount,
    };
  }

  const fallbackTotalCount = args.engineItems.length + rawPartCompletedCount;
  const completedCount = engineAcceptedCount + rawPartCompletedCount;
  return {
    shippedCount: completedCount,
    completedCount,
    totalCount: fallbackTotalCount,
    progress01: fallbackTotalCount > 0 ? Math.min(1, completedCount / fallbackTotalCount) : null,
    progressPct: fallbackTotalCount > 0 ? Math.min(100, (completedCount / fallbackTotalCount) * 100) : null,
    engineAcceptedCount,
    enginePlannedCount,
    partCompletedCount,
    rawPartCompletedCount,
    partPlannedCount,
  };
}

const defaultPrimary: ContractPrimarySection = {
  number: '',
  signedAt: null,
  dueAt: null,
  internalNumber: '',
  customerId: null,
  engineBrands: [],
  parts: [],
};

export function parseContractSections(attrs: Record<string, unknown> | null | undefined): ContractSections {
  const safeAttrs = attrs && typeof attrs === 'object' ? attrs : {};
  const raw = safeAttrs.contract_sections;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    const primary = obj.primary as ContractPrimarySection | undefined;
    const addons = Array.isArray(obj.addons) ? obj.addons : [];
    return {
      primary: primary && typeof primary.number === 'string'
        ? {
            number: String(primary.number),
            signedAt: typeof primary.signedAt === 'number' ? primary.signedAt : null,
            dueAt: typeof primary.dueAt === 'number' ? primary.dueAt : null,
            internalNumber: String(primary.internalNumber ?? primary.number ?? ''),
            customerId: primary.customerId != null ? String(primary.customerId) : null,
            engineBrands: Array.isArray(primary.engineBrands) ? primary.engineBrands.filter((r) => r && typeof r.engineBrandId === 'string') : [],
            parts: Array.isArray(primary.parts) ? primary.parts.filter((p) => p && typeof p.partId === 'string') : [],
          }
        : { ...defaultPrimary },
      addons: addons.map((a: unknown, idx: number) => {
        const add = a && typeof a === 'object' ? (a as Record<string, unknown>) : {};
        return {
          number: String(add.number ?? ''),
          // Persisted seq wins; legacy addons fall back to positional (idx+1) so they
          // still display «ДС 1, ДС 2…» before the contract is re-saved (which freezes seq).
          seq: typeof add.seq === 'number' && Number.isFinite(add.seq) ? Number(add.seq) : idx + 1,
          signedAt: typeof add.signedAt === 'number' ? add.signedAt : null,
          dueAt: typeof add.dueAt === 'number' ? add.dueAt : null,
          createdAt: typeof add.createdAt === 'number' ? add.createdAt : null,
          note: typeof add.note === 'string' ? add.note : '',
          engineBrands: Array.isArray(add.engineBrands) ? (add.engineBrands as ContractEngineBrandRow[]).filter((r) => r && typeof r.engineBrandId === 'string') : [],
          parts: Array.isArray(add.parts) ? (add.parts as ContractPartRow[]).filter((p) => p && typeof p.partId === 'string') : [],
        };
      }),
    };
  }
  const primary: ContractPrimarySection = {
    ...defaultPrimary,
    number: String(safeAttrs.number ?? ''),
    signedAt: typeof safeAttrs.date === 'number' ? safeAttrs.date : null,
    dueAt: typeof safeAttrs.due_date === 'number' ? safeAttrs.due_date : null,
    internalNumber: String(safeAttrs.internal_number ?? ''),
    customerId: safeAttrs.customer_id != null ? String(safeAttrs.customer_id) : null,
  };
  return { primary, addons: [] };
}

/** Следующий стабильный seq для нового ДС (max существующих + 1, не переиспользует удалённые). */
export function nextAddonSeq(sections: ContractSections): number {
  let max = 0;
  for (const a of sections.addons) if (typeof a.seq === 'number' && a.seq > max) max = a.seq;
  return max + 1;
}

/** Токен привязки двигателя к ДС (хранится в engine.contract_section_number). */
export function contractSectionAddonToken(seq: number): string {
  return `ДС ${seq}`;
}

/** Является ли значение `contract_section_number` токеном ДС («ДС {seq}»), а не номером основного договора. */
export function isContractAddonToken(sectionNumber: string | null | undefined): boolean {
  return /^ДС\s/.test(String(sectionNumber ?? '').trim());
}

/**
 * Статус привязки двигателя к контракту для списка двигателей:
 * - `contract` — привязан к основному договору (есть contractId, секция не ДС);
 * - `addon` — привязан к ДС (есть contractId, секция = «ДС {seq}»);
 * - `none` — не привязан (нет contractId).
 */
export type EngineContractBinding = 'contract' | 'addon' | 'none';

export function classifyEngineContractBinding(args: {
  contractId?: string | null;
  contractSectionNumber?: string | null;
}): EngineContractBinding {
  if (!String(args.contractId ?? '').trim()) return 'none';
  return isContractAddonToken(args.contractSectionNumber) ? 'addon' : 'contract';
}

/** Дата в формате ДД.ММ.ГГГГ для человекочитаемых лейблов секций контракта. */
export function formatContractDate(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return '';
  const d = new Date(ms);
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}.${mm}.${d.getFullYear()}`;
}

export type ContractSectionOption = { id: string; label: string; isPrimary: boolean };

/**
 * Опции выбора секции контракта (основной договор + каждое ДС) для дропдауна привязки
 * в карточке двигателя. Лейбл ДС — «ДС {N} — от ДД.ММ.ГГГГ»; id — стабильный токен
 * привязки. Раньше дропдаун показывал просто номер контракта у всех ДС → оператор
 * не различал, какое ДС выбрать.
 */
export function buildContractSectionOptions(sections: ContractSections): ContractSectionOption[] {
  const out: ContractSectionOption[] = [];
  const primaryNumber = String(sections.primary.number ?? '').trim();
  if (primaryNumber) out.push({ id: primaryNumber, label: `Договор ${primaryNumber}`, isPrimary: true });
  for (const addon of sections.addons) {
    const date = formatContractDate(addon.signedAt);
    out.push({
      id: contractSectionAddonToken(addon.seq),
      label: date ? `ДС ${addon.seq} — от ${date}` : `ДС ${addon.seq} — без даты`,
      isPrimary: false,
    });
  }
  return out;
}

/** Окно «новизны» контракта/ДС для напоминания — 3 дня. */
export const CONTRACT_ACTIVITY_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

export type ContractActivityAlert = {
  kind: 'contract' | 'addon';
  contractId: string;
  contractNumber: string;
  /** Номер ДС (только для kind='addon'). */
  seq?: number;
  createdAt: number;
};

/**
 * Собирает напоминания «заведён новый контракт/ДС» по одному контракту: контракт
 * считается новым, если его createdAt в окне; ДС — если его createdAt в окне.
 * Чисто по данным (createdAt), поэтому гаснет автоматически через окно — без отдельного
 * состояния «прочитано». Легаси-ДС без createdAt не алармят.
 */
export function collectContractActivityAlerts(args: {
  contractId: string;
  contractNumber: string;
  contractCreatedAt: number | null;
  sections: ContractSections;
  now: number;
  windowMs?: number;
}): ContractActivityAlert[] {
  const { contractId, contractNumber, contractCreatedAt, sections, now } = args;
  const windowMs = args.windowMs ?? CONTRACT_ACTIVITY_WINDOW_MS;
  const inWindow = (ts: number | null | undefined): ts is number =>
    ts != null && Number.isFinite(ts) && now - ts >= 0 && now - ts <= windowMs;
  const out: ContractActivityAlert[] = [];
  if (inWindow(contractCreatedAt)) {
    out.push({ kind: 'contract', contractId, contractNumber, createdAt: contractCreatedAt });
  }
  for (const addon of sections.addons) {
    if (inWindow(addon.createdAt)) {
      out.push({ kind: 'addon', contractId, contractNumber, seq: addon.seq, createdAt: addon.createdAt });
    }
  }
  return out;
}

export function effectiveContractDueAt(sections: ContractSections): number | null {
  let dueAt: number | null = sections.primary.dueAt ?? null;
  for (const addon of sections.addons) {
    if (addon.dueAt != null) dueAt = addon.dueAt;
  }
  return dueAt;
}

export function contractSectionsToLegacy(
  sections: ContractSections,
): { number: string; internal_number: string; date: number | null; due_date: number | null } {
  const p = sections.primary;
  return {
    number: p.number,
    internal_number: p.internalNumber,
    date: p.signedAt,
    due_date: effectiveContractDueAt(sections),
  };
}

/** Марки двигателей из всех секций контракта (основная + допсоглашения), порядок — как в данных. */
export function collectEngineBrandIdsFromContractSections(sections: ContractSections | null | undefined): string[] {
  if (!sections) return [];
  const out: string[] = [];
  const add = (rows: ContractEngineBrandRow[]) => {
    for (const r of rows) {
      const id = String(r.engineBrandId ?? '').trim();
      if (id) out.push(id);
    }
  };
  add(sections.primary.engineBrands);
  for (const addon of sections.addons) add(addon.engineBrands);
  return out;
}

/** Сумма количеств по каждой марке (первичный договор и все ДС). */
export function sumEngineBrandQtyByBrandFromContractSections(sections: ContractSections | null | undefined): Map<string, number> {
  const m = new Map<string, number>();
  if (!sections) return m;
  const add = (rows: ContractEngineBrandRow[]) => {
    for (const r of rows) {
      const id = String(r.engineBrandId ?? '').trim();
      if (!id) continue;
      const q = normalizeQty(r.qty);
      if (q <= 0) continue;
      m.set(id, (m.get(id) ?? 0) + q);
    }
  };
  add(sections.primary.engineBrands);
  for (const addon of sections.addons) add(addon.engineBrands);
  return m;
}

/**
 * Ожидаемый % исполнения по линейному графику от даты подписания до срока.
 * Возвращает null, если нет осмысленного интервала дат.
 */
export function linearScheduleExpectedProgressPct(args: { signedAt: number | null; dueAt: number | null; now: number }): number | null {
  const { signedAt, dueAt, now } = args;
  if (signedAt == null || dueAt == null) return null;
  const total = dueAt - signedAt;
  if (total <= 0) return null;
  const elapsed = now - signedAt;
  const p = (elapsed / total) * 100;
  return Math.max(0, Math.min(100, p));
}

export type ContractScheduleLagInput = {
  actualProgressPct: number;
  signedAt: number | null;
  dueAt: number | null;
  now: number;
  /** Минимальный разрыв «ожидаемое − факт», % (по графику подписание→срок). */
  minGapPct?: number;
};

/**
 * Контракт «отстаёт от графика»: просрочен при неполном исполнении или факт существенно ниже линейного ожидания.
 */
export function isContractLaggingVsSchedule(input: ContractScheduleLagInput): boolean {
  const { actualProgressPct, signedAt, dueAt, now, minGapPct = 10 } = input;
  if (actualProgressPct >= 99.5) return false;
  if (dueAt != null && now > dueAt) return true;
  const expected = linearScheduleExpectedProgressPct({ signedAt, dueAt, now });
  if (expected == null) return false;
  return expected - actualProgressPct >= minGapPct;
}
