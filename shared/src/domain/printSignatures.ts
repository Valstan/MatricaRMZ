/**
 * Подписи печатных форм — общий слой (заказ владельца 23.11.2026).
 *
 * Требование: «В печатной форме блок подписей нужно сделать редактируемым, чтобы
 * можно было добавлять другие подписи, с другими людьми, с другими профессиями,
 * должностями. Добавлять и удалять подписи».
 *
 * Правило одно на все печатные формы:
 *  - **слот** = должность (что печатается над строкой) + человек (сотрудник из базы
 *    или ФИО, вписанное от руки);
 *  - **слоты, заданные оператором, печатаются как есть** — их нельзя терять, иначе
 *    добавленная подпись исчезнет (это и был корень: прежде слоты, которых нет в
 *    списке ролей по умолчанию, отбрасывались);
 *  - **удалённая оператором роль не возвращается** — значит, сохранённый набор
 *    заменяет роли по умолчанию целиком, а не дополняет их;
 *  - **роли по умолчанию печатаются, пока оператор не правил блок** — программа,
 *    созданная до появления редактора, печатается с полным комплектом строк.
 *
 * Формы, которые печатаются по шаблону (`shared/src/domain/printTemplate.ts`,
 * поля `source: 'signature_role'`), свой механизм имеют — этот слой для форм,
 * печатаемых мимо шаблона (сегодня это производственная программа).
 */

/** Слот подписи: должность + человек. */
export type PrintSignatureSlot = {
  /** Должность/профессия — печатается над строкой подписи. */
  caption: string;
  /** id сотрудника из базы; null — ФИО вписано вручную или не выбрано. */
  employeeId: string | null;
  /** ФИО, вписанное вручную (или взятое из образца документа), если сотрудник не выбран. */
  fullName: string;
};

/**
 * Разбор сохранённых слотов (JSON-строка в документе или уже готовый массив).
 *
 * Мусор и неизвестные значения не роняют разбор. Пустая подпись (есть слот, но
 * подпись не выбрана) — **не мусор**: она печатается пустой строкой, под которую
 * подписывают от руки. Поэтому слот без должности, но с ключом `caption`,
 * сохраняется.
 */
export function parsePrintSignatureSlots(raw: unknown): PrintSignatureSlot[] {
  let value: unknown = raw;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return [];
    try {
      value = JSON.parse(trimmed);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];
  const out: PrintSignatureSlot[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const employeeId = String(rec.employeeId ?? '').trim();
    const fullName = String(rec.fullName ?? '').trim();
    const caption = String(rec.caption ?? '').trim();
    // Совсем пустой предмет — мусор; пустой слот (ключ `caption` есть, имени нет) —
    // пустая строка под подпись от руки, её сохраняем.
    if (!('caption' in rec) && !employeeId && !fullName) continue;
    out.push({
      caption,
      employeeId: employeeId || null,
      fullName,
    });
  }
  return out;
}

/** Слоты — в строку для хранения (в документе это JSON-текст). */
export function serializePrintSignatureSlots(slots: readonly PrintSignatureSlot[]): string {
  return JSON.stringify(
    (slots ?? []).map((slot) => ({
      caption: String(slot.caption ?? '').trim(),
      employeeId: String(slot.employeeId ?? '').trim() || null,
      fullName: String(slot.fullName ?? '').trim(),
    })),
  );
}

/**
 * Слоты для печати: заданные оператором — как есть; если их нет — роли по
 * умолчанию.
 *
 * Именно это отличает «оператор добавил подпись» от «программа создана до правки
 * блока подписей», и именно этим правилом прежний код терял добавленную подпись:
 * он возвращал **только** роли по умолчанию.
 */
export function resolvePrintSignatureSlots(
  saved: readonly PrintSignatureSlot[] | null | undefined,
  defaults: readonly PrintSignatureSlot[] | null | undefined,
): PrintSignatureSlot[] {
  // `null` — «оператор не правил блок» (печатаем роли по умолчанию); пустой массив —
  // «оператор снял все подписи» (не печатаем ничего).
  if (saved == null) return parsePrintSignatureSlots(defaults ?? null);
  return parsePrintSignatureSlots(saved);
}

/** Добавить слот в конец блока. */
export function addPrintSignatureSlot(
  slots: readonly PrintSignatureSlot[],
  slot: Partial<PrintSignatureSlot> = {},
): PrintSignatureSlot[] {
  return [
    ...(slots ?? []),
    {
      caption: String(slot.caption ?? '').trim(),
      employeeId: String(slot.employeeId ?? '').trim() || null,
      fullName: String(slot.fullName ?? '').trim(),
    },
  ];
}

/** Изменить слот по индексу (должность, сотрудник, ФИО). */
export function updatePrintSignatureSlot(
  slots: readonly PrintSignatureSlot[],
  index: number,
  patch: Partial<PrintSignatureSlot>,
): PrintSignatureSlot[] {
  return (slots ?? []).map((slot, idx) => {
    if (idx !== index) return slot;
    return {
      caption: patch.caption !== undefined ? String(patch.caption ?? '').trim() : slot.caption,
      employeeId:
        patch.employeeId !== undefined ? String(patch.employeeId ?? '').trim() || null : slot.employeeId,
      fullName: patch.fullName !== undefined ? String(patch.fullName ?? '').trim() : slot.fullName,
    };
  });
}

/** Убрать слот из блока. */
export function removePrintSignatureSlot(
  slots: readonly PrintSignatureSlot[],
  index: number,
): PrintSignatureSlot[] {
  return (slots ?? []).filter((_, idx) => idx !== index);
}
