/**
 * Карточка выдачи СИЗ — форма, которой владелец пользуется на бумаге.
 *
 * Образец (22 файла «Карточка выдачи СИЗ <должность>» из папки владельца):
 * таблица **11 колонок** —
 *   Наименование СИЗ · № сертификата соответствия ·
 *   Выдано: Дата · Кол-во · % износа · подпись в получении ·
 *   Возвращено: Дата · Кол-во · % износа · Подпись работника о сдаче · Кладовщика в получении.
 *
 * Модуль уже умеет всё, что в этих колонках: сертификат позиции (`erp_nomenclature.certificate`,
 * миграция 0127), процент износа (`ppe_issue_entries.wear_percent`, миграция 0126) и отметку
 * «получил обратно» (`ppe_issue_entries.returned_at`). Не хватало самой формы.
 *
 * Два режима печати:
 * - **бланк по должности** — строки норм набора, колонки выдачи пустые (подпись от руки);
 * - **карточка сотрудника** — те же строки, но с его историей выдач и возвратов.
 */

export type PpeIssueCardPosition = {
  nomenclatureId: string;
  /** Наименование позиции (как в справочнике). */
  name: string;
  /** № сертификата соответствия. */
  certificate: string | null;
  /** Единица измерения. */
  unit: string | null;
};

export type PpeIssueCardFact = {
  nomenclatureId: string;
  issuedAt: number;
  qty: number;
  /** Процент износа — заполняет кладовщик. */
  wearPercent: number | null;
  /** Дата «получил обратно» — `null`, пока вещь у сотрудника. */
  returnedAt: number | null;
  /** Наименование позиции — нужно, когда выдано то, чего нет в норме. */
  name?: string | null;
  certificate?: string | null;
};

export type PpeIssueCardLine = {
  position: PpeIssueCardPosition;
  /** Событие выдачи по этой позиции; `null` — строка бланка (ещё не выдавали). */
  fact: PpeIssueCardFact | null;
  /** Продолжение позиции: вторая и последующие выдачи — название не печатается снова. */
  continued: boolean;
};

export type PpeIssueCard = {
  lines: PpeIssueCardLine[];
  /** Сколько позиций в карточке. */
  positionsCount: number;
  /** Сколько выдач в карточке. */
  factsCount: number;
};

/**
 * Собирает строки карточки выдачи.
 *
 * - позиции идут в том порядке, в котором их дали (порядок норм);
 * - выдачи привязываются к позиции по `nomenclatureId` и идут по хронологии;
 * - позиция без выдачи — строка бланка (колонки пустые, подпись от руки);
 * - выдача позиции, которой нет в нормах, не теряется: она добавляется отдельной строкой.
 */
export function buildPpeIssueCard(args: {
  positions: PpeIssueCardPosition[];
  facts: PpeIssueCardFact[];
}): PpeIssueCard {
  const positions = args.positions ?? [];
  const facts = (args.facts ?? []).slice().sort((a, b) => Number(a.issuedAt) - Number(b.issuedAt));

  const byPosition = new Map<string, PpeIssueCardFact[]>();
  for (const fact of facts) {
    const list = byPosition.get(fact.nomenclatureId) ?? [];
    list.push(fact);
    byPosition.set(fact.nomenclatureId, list);
  }

  const lines: PpeIssueCardLine[] = [];
  const used = new Set<string>();

  for (const position of positions) {
    const positionFacts = byPosition.get(position.nomenclatureId) ?? [];
    if (positionFacts.length === 0) {
      lines.push({ position, fact: null, continued: false });
      continue;
    }
    used.add(position.nomenclatureId);
    positionFacts.forEach((fact, index) => {
      lines.push({ position, fact, continued: index > 0 });
    });
  }

  // Выданное, чего нет в норме, — отдельной строкой: подпись в получении всё равно есть.
  for (const fact of facts) {
    if (used.has(fact.nomenclatureId)) continue;
    used.add(fact.nomenclatureId);
    lines.push({
      position: {
        nomenclatureId: fact.nomenclatureId,
        name: String(fact.name ?? '').trim(),
        certificate: fact.certificate ?? null,
        unit: null,
      },
      fact,
      continued: false,
    });
  }

  return { lines, positionsCount: positions.length, factsCount: facts.length };
}
