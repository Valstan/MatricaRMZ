// Группировка списка марок двигателей по секциям-группам для представления «Секции по группам».
// Марка может входить в несколько групп — тогда она показывается в каждой своей секции (дубли
// осознанны, как во фильтре по группе). Марки без группы — в отдельной секции в конце.
// Порядок марок внутри секции сохраняется как во входном массиве (он уже отсортирован вызывающим).

export type BrandGroupSection<T> = {
  /** id группы; null — виртуальная секция «Без группы». */
  groupId: string | null;
  label: string;
  brands: T[];
};

export function groupBrandsIntoSections<T extends { id: string }>(
  brands: ReadonlyArray<T>,
  brandToGroups: ReadonlyMap<string, ReadonlyArray<string>>,
  groups: ReadonlyArray<{ id: string; label: string }>,
  noGroupLabel: string,
): Array<BrandGroupSection<T>> {
  const sections: Array<BrandGroupSection<T>> = [];
  for (const group of groups) {
    const inGroup = brands.filter((b) => (brandToGroups.get(b.id) ?? []).includes(group.id));
    if (inGroup.length > 0) {
      sections.push({ groupId: group.id, label: group.label, brands: inGroup });
    }
  }
  const ungrouped = brands.filter((b) => (brandToGroups.get(b.id) ?? []).length === 0);
  if (ungrouped.length > 0) {
    sections.push({ groupId: null, label: noGroupLabel, brands: ungrouped });
  }
  return sections;
}
