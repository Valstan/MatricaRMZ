// Торговое наименование и сертификат позиции набора — для печати бланка выдачи.
//
// Промты КАРМАНА #20/#25: в должностной карточке выдачи у владельца наименование
// и № сертификата — по должности («Костюм МОТОР» — одна вещь на все карточки,
// а сертификат у перчаток по профессиям разный). Значит, печатать надо торговые
// данные позиции набора, а справочное имя номенклатуры — только если торговых
// нет (старые наборы, где полей ещё не завели).

export type PpeTradePosition = {
  /** Торговое наименование позиции («Костюм МОТОР»). */
  name: string | null;
  /** № сертификата позиции. */
  certificate: string | null;
};

/** Строка набора норм — в том виде, в каком её отдаёт сервер. */
export type PpeNormLineTradeInput = {
  nomenclatureId: string;
  tradeName?: string | null;
  certificate?: string | null;
};

/**
 * Собирает «номенклатура позиции → торговые данные».
 *
 * Ключ — номенклатура строки набора (база вида СИЗ). Размерные варианты ведут
 * к базе: выдача записывается по конкретной вещи («Сапоги ТОФФ АЛЬП … (43)»),
 * а торговые данные живут у позиции набора, то есть у базы. Поэтому варианты
 * получают те же данные, что и их база.
 */
export function buildTradeByNom(
  lines: PpeNormLineTradeInput[],
  nomParents: Map<string, string> = new Map(),
): Map<string, PpeTradePosition> {
  const map = new Map<string, PpeTradePosition>();
  for (const line of lines) {
    const id = String(line.nomenclatureId);
    const current = map.get(id);
    map.set(id, {
      name: line.tradeName ?? current?.name ?? null,
      certificate: line.certificate ?? current?.certificate ?? null,
    });
  }
  for (const [id, parentId] of nomParents) {
    if (map.has(id)) continue;
    const parent = map.get(parentId);
    if (parent) map.set(id, parent);
  }
  return map;
}

/**
 * Торговые данные позиции по номенклатуре; `null` — торговых данных нет,
 * печатаем справочные (имя номенклатуры и её сертификат).
 */
export function resolveTradePosition(
  map: Map<string, PpeTradePosition>,
  nomenclatureId: string,
): PpeTradePosition | null {
  return map.get(String(nomenclatureId)) ?? null;
}
