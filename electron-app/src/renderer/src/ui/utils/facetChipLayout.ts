/**
 * Раскладка плавающих плашек выбранных значений фильтра (владелец 12.11.2026).
 *
 * Плашки стоят под своей кнопкой-родителем, но разные ступени стоят рядом — и широкие
 * плашки наезжали друг на друга (владелец 12.11.2026: «наезжают друг на друга, прочитать
 * невозможно, что выбрано, и отключить невозможно»).
 *
 * Отсюда задача, которую решает этот модуль: **все плашки в одну строку, ни одна не наезжает
 * на другую, и каждая тянется к своей кнопке-родителю**. Ровно это умело меню Матрицы
 * первой и второй версии: дочернее меню открывалось под кнопкой, а если место было занято —
 * сдвигалось, но всё равно старалось остаться под родителем.
 *
 * Алгоритм (чистая функция — проверяется юнит-тестом, а не глазами):
 *
 * 1. Желаемая позиция группы — по центру её кнопки-родителя.
 * 2. **Вперёд**: группа, которой не хватило места, сдвигается вправо — минимально, ровно на
 *   столько, чтобы не наехать на левого соседа. Это и есть «сдвигались, если место занято».
 * 3. **Назад**: группы тянутся влево, к своим родителям, — насколько позволяет правый сосед.
 *    Места хватает — плашка возвращается под свою кнопку.
 * 4. **Вперёд ещё раз**: натягивание влево могло свести две группы — раздвигаем.
 * 5. Если блок уехал за правый край — подтягиваем его целиком влево и снова раздвигаем.
 *
 * Если плашки в сумме шире строки, полотно расширяется (`canvas`): тогда группа может выйти
 * за правый край панели — но такая расстановка лучше, чем наезд друг на друга.
 */

export type FacetChipGroup = {
  /** id ступени-родителя. */
  id: string;
  /** Ширина группы плашек, px. */
  width: number;
  /** Центр кнопки-родителя относительно левого края ряда плашек, px. */
  parentCenter: number;
};

export type FacetChipLayoutPlan = {
  /** Левый край каждой группы в ряду, px (id ступени → смещение). */
  positions: Record<string, number>;
  /** Суммарная ширина групп вместе с зазорами, px. */
  totalWidth: number;
  /** Ширина полотна, на котором стоят группы: не меньше ширины ряда. */
  canvasWidth: number;
};

/** Зазор между группами плашек, px. */
export const FACET_CHIP_GROUP_GAP = 4;

export function layoutFacetChipGroups(
  groups: readonly FacetChipGroup[],
  availableWidth: number,
  gap: number = FACET_CHIP_GROUP_GAP,
): FacetChipLayoutPlan {
  const positions: Record<string, number> = {};
  const count = groups.length;
  if (count === 0) return { positions, totalWidth: 0, canvasWidth: Math.max(0, availableWidth) };

  const widths = groups.map((group) => Math.max(0, group.width));
  const totalWidth = widths.reduce((sum, width) => sum + width, 0) + gap * (count - 1);
  // Полотно не меньше ряда: иначе группам негде стоять, и они бы вылезли за края панели.
  const canvasWidth = Math.max(availableWidth, totalWidth);

  // 1. Желаемая позиция — по центру родителя, в границах полотна.
  const pos = groups.map((group, index) => {
    const width = widths[index]!;
    const desired = group.parentCenter - width / 2;
    return Math.min(Math.max(desired, 0), Math.max(0, canvasWidth - width));
  });

  // 2. Вперёд: сдвиг вправо, если место справа от родителя уже занято.
  for (let i = 1; i < count; i++) {
    pos[i] = Math.max(pos[i]!, pos[i - 1]! + widths[i - 1]! + gap);
  }

  // 3. Назад: тянем к родителям — насколько позволяет правый сосед.
  for (let i = count - 2; i >= 0; i--) {
    pos[i] = Math.min(pos[i]!, pos[i + 1]! - widths[i]! - gap);
  }

  // 4. Вперёд ещё раз: после натягивания влево две группы могли сойтись.
  for (let i = 1; i < count; i++) {
    pos[i] = Math.max(pos[i]!, pos[i - 1]! + widths[i - 1]! + gap);
  }

  // 5. Блок уехал за правый край — подтягиваем его влево и раздвигаем заново.
  for (let pass = 0; pass < 3; pass++) {
    const overflow = pos[count - 1]! + widths[count - 1]! - canvasWidth;
    if (overflow <= 0.5) break;
    const shift = Math.min(overflow, pos[0]!);
    for (let i = 0; i < count; i++) pos[i] = pos[i]! - shift;
    for (let i = 1; i < count; i++) {
      pos[i] = Math.max(pos[i]!, pos[i - 1]! + widths[i - 1]! + gap);
    }
  }

  for (let i = 0; i < count; i++) {
    positions[groups[i]!.id] = Math.round(pos[i]! * 100) / 100;
  }
  return { positions, totalWidth, canvasWidth };
}
