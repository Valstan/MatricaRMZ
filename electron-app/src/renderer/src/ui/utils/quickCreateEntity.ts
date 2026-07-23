import type { QuickCreateRequest, QuickCreateResult } from '@matricarmz/shared';

import { normalizeLookupText } from './searchMatching.js';

export async function quickCreateEntity(request: QuickCreateRequest): Promise<QuickCreateResult | null> {
  const types = await window.matrica.admin.entityTypes.list();
  const type = types.find((entry) => String(entry.code) === request.target);
  if (!type?.id) throw new Error(`Справочник «${request.target}» не найден`);

  const article = request.fields?.article == null ? '' : String(request.fields.article).trim();
  const inn = request.fields?.inn == null ? '' : String(request.fields.inn).trim();
  const price = request.fields?.price == null ? undefined : Number(request.fields.price);
  const duplicateQuery = {
    name: request.label,
    ...(article ? { article } : {}),
    ...(inn ? { inn } : {}),
    ...(price !== undefined && Number.isFinite(price) ? { price } : {}),
  };
  const duplicates = await window.matrica.admin.entities.findDuplicates({
    entityTypeId: String(type.id),
    query: duplicateQuery,
  });
  const exact = (duplicates ?? []).find((candidate) => {
    const sameName = normalizeLookupText(candidate.displayName) === normalizeLookupText(request.label);
    const sameArticle = !article || normalizeLookupText(String(candidate.attributes?.article ?? '')) === normalizeLookupText(article);
    const sameInn = !inn || normalizeLookupText(String(candidate.attributes?.inn ?? '')) === normalizeLookupText(inn);
    return sameName || sameArticle || sameInn;
  });
  if (exact) return { id: exact.id, label: exact.displayName, existing: true };

  const created = await window.matrica.admin.entities.create(String(type.id));
  if (!created?.ok || !created.id) {
    throw new Error(String((created as { error?: string })?.error ?? 'Не удалось создать элемент'));
  }

  try {
    const defs = await window.matrica.admin.attributeDefs.listByEntityType(String(type.id));
    const allowedCodes = new Set(defs.map((def) => String(def.code)));
    const values: Record<string, unknown> = { name: request.label, ...(request.fields ?? {}) };
    const aliases: Record<string, string[]> = {
      abbreviation: ['abbreviation', 'short_name', 'short'],
      withoutArticle: ['without_article'],
    };
    for (const [sourceCode, rawValue] of Object.entries(values)) {
      const targetCode = allowedCodes.has(sourceCode)
        ? sourceCode
        : (aliases[sourceCode] ?? []).find((candidate) => allowedCodes.has(candidate));
      if (!targetCode || rawValue === '' || rawValue === undefined) continue;
      const result = await window.matrica.admin.entities.setAttr(created.id, targetCode, rawValue);
      if (result && typeof result === 'object' && 'ok' in result && result.ok === false) {
        throw new Error(String((result as { error?: string }).error ?? `Не удалось записать ${targetCode}`));
      }
    }
  } catch (error) {
    await window.matrica.admin.entities.softDelete(created.id).catch(() => undefined);
    throw error;
  }
  return { id: created.id, label: request.label, existing: false };
}
