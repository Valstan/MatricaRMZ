// Канонические имена этапов для PR3-миграций (таблица 05.10.2026).
//
// ЗАМОРОЖЕННАЯ копия — НЕ импортировать из @matricarmz/shared: скрипты данных
// едут на прод отдельно от релиза, и shared/dist на боксе может быть старше
// (тогда каноном стали бы прежние имена, и миграция ничего бы не нашла).
// Сверено с DEFAULT_REPAIR_STAGE_TEMPLATES на момент PR3.
export const PR3_CANONICAL_STAGE_NAMES: Readonly<Record<string, string>> = {
  card_created: 'Создание карточки двигателя',
  arrival: 'Приемка двигателя на завод',
  disassembly_defect: 'Разборка/Дефектовка',
  ukladka: 'Укладка вала',
  sborka: 'Сборка двигателя',
  obkatka: 'Обкатка двигателя',
  otk: 'Выходной контроль ОТК',
  shipped: 'Отгрузка двигателя заказчику',
  accepted: 'Приемка двигателя заказчиком',
  scrap_branch: 'Утиль и брак',
};

export function pr3CanonicalName(code: string): string | null {
  return PR3_CANONICAL_STAGE_NAMES[code] ?? null;
}
