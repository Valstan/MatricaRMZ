export type LinkRule = { fieldName: string; targetTypeCode: string; priority: number };

export type LinkTypeOption<T extends { code: string }> = { type: T; tag?: 'standard' | 'recommended' };

export function normalizeForMatch(s: string) {
  return String(s ?? '').trim().toLowerCase();
}

export function suggestLinkTargetCode(name: string): string | null {
  const n = normalizeForMatch(name);
  if (!n) return null;
  const rules: Array<{ match: RegExp; code: string }> = [
    { match: /подраздел|служб|департамент|отдел/, code: 'department' },
    { match: /участок/, code: 'section' },
    { match: /цех|мастерск|производств/, code: 'workshop' },
    { match: /заказчик|клиент|контрагент/, code: 'customer' },
    { match: /контракт|договор/, code: 'contract' },
    { match: /наряд|заказ|производств.*заказ/, code: 'work_order' },
    { match: /деталь|компонент|зип|запчаст/, code: 'part' },
    { match: /двигател|мотор/, code: 'engine' },
    { match: /марк.*двиг|бренд.*двиг|модель.*двиг/, code: 'engine_brand' },
    { match: /услуг|сервис/, code: 'service' },
    { match: /номенклатур|товар|издели|продукт/, code: 'product' },
    { match: /сотрудник|работник|персонал/, code: 'employee' },
    { match: /поставщик|снабжен/, code: 'customer' },
  ];
  for (const r of rules) {
    if (r.match.test(n)) return r.code;
  }
  return null;
}

export function suggestLinkTargetCodeWithRules(name: string, rules: LinkRule[]): string | null {
  const n = normalizeForMatch(name);
  if (!n) return null;
  const sorted = [...rules].sort((a, b) => b.priority - a.priority);
  for (const r of sorted) {
    const rn = normalizeForMatch(r.fieldName);
    if (!rn) continue;
    if (n.includes(rn) || rn.includes(n)) return r.targetTypeCode;
  }
  return suggestLinkTargetCode(name);
}

export function buildLinkTypeOptions<T extends { code: string }>(
  types: T[],
  standardCode?: string | null,
  recommendedCode?: string | null,
): LinkTypeOption<T>[] {
  const standardType = standardCode ? types.find((t) => t.code === standardCode) ?? null : null;
  const recommendedType = recommendedCode ? types.find((t) => t.code === recommendedCode) ?? null : null;
  const out: LinkTypeOption<T>[] = [];
  if (standardType) out.push({ type: standardType, tag: 'standard' });
  if (recommendedType && recommendedType.code !== standardType?.code) out.push({ type: recommendedType, tag: 'recommended' });
  for (const t of types) {
    if (t.code === standardType?.code || t.code === recommendedType?.code) continue;
    out.push({ type: t });
  }
  return out;
}
