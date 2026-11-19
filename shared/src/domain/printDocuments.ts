/**
 * Документы печатных форм: заполненные экземпляры формы (промты КАРМАНА #4/#5).
 *
 * Документ — не шаблон: шаблон описывает форму, документ хранит ЗАПОЛНЕННЫЕ значения
 * и снимок раскладки на момент заполнения. Правка шаблона не переписывает уже
 * отправленный документ.
 *
 * Приёмка — явное действие получателя: `draft → sent → accepted | rejected`.
 * Синхронизация строк приёмку не заменяет, решение остаётся за человеком.
 */

export type PrintDocumentStatus = 'draft' | 'sent' | 'accepted' | 'rejected';

export const PRINT_DOCUMENT_STATUS_TITLES: Record<PrintDocumentStatus, string> = {
  draft: 'Черновик',
  sent: 'Отправлен',
  accepted: 'Принят',
  rejected: 'Отклонён',
};

export type PrintDocumentDto = {
  id: string;
  entityKey: string;
  formKey: string;
  templateId: string | null;
  title: string;
  /** Заполненные значения полей: `{ fieldId: value }`. */
  valuesJson: string;
  /** Снимок раскладки шаблона на момент заполнения. */
  layoutJson: string;
  status: PrintDocumentStatus;
  authorId: string;
  authorUsername: string;
  recipientId: string | null;
  recipientUsername: string | null;
  note: string;
  decisionNote: string;
  decidedAt: number | null;
  decidedBy: string | null;
  createdAt: number;
  updatedAt: number;
};

/** Разбор заполненных значений документа: битый JSON — пустые значения, а не падение. */
export function parsePrintDocumentValues(raw: string | null | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string') out[key] = value;
      else if (value != null) out[key] = String(value);
    }
    return out;
  } catch {
    return {};
  }
}
