/**
 * Контакт техподдержки, который видит оператор в окне приветствия релиза.
 *
 * Значение приезжает из **настроек экземпляра** (строка `__global_ui_defaults__`
 * таблицы `client_settings`), а не из кода: показывать сотруднику и публиковать в
 * открытом git — два разных вопроса, и первый не требует второго (решение
 * владельца, brain D-042). Репозиторий публичен с 2026-08-17, поэтому личных
 * контактов в отслеживаемых файлах не держим — см. `AGENTS.md`
 * §«Персональные данные сотрудников».
 */
export type SupportContact = {
  /** Телефон как его набирает человек; формат не навязываем — заводу виднее. */
  phone: string;
  /** Кому звонить: имя и, при желании, должность. */
  person: string;
};

export const EMPTY_SUPPORT_CONTACT: SupportContact = { phone: '', person: '' };

const PHONE_MAX = 40;
const PERSON_MAX = 120;

function cleanLine(raw: unknown, max: number): string {
  return String(raw ?? '')
    // Переводы строк и управляющие символы: значение рендерится одной строкой, а
    // приезжает из БД, куда его кладёт скрипт или админ.
    .replace(/[\p{Cc}\p{Cf}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

export function sanitizeSupportContact(raw: unknown): SupportContact {
  if (!raw || typeof raw !== 'object') return EMPTY_SUPPORT_CONTACT;
  const src = raw as Record<string, unknown>;
  return {
    phone: cleanLine(src.phone, PHONE_MAX),
    person: cleanLine(src.person, PERSON_MAX),
  };
}

/** Есть ли что показывать: пустой контакт прячет блок целиком, а не рисует дыру. */
export function hasSupportContact(contact: SupportContact | null | undefined): boolean {
  if (!contact) return false;
  return contact.phone.length > 0 || contact.person.length > 0;
}
