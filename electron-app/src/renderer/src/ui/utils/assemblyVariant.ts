// Авто-сгенерированный ключ варианта сборки BOM (`__kit_<hex>`) — внутренний,
// оператору его показывать нельзя. Заменяем на «Вариант N» по порядку отображения.
// Если у варианта задано человеческое имя (не `__kit_`-ключ) — показываем его как есть.
export function formatAssemblyVariantLabel(variantGroup: string | null | undefined, index: number): string {
  const vg = String(variantGroup ?? '').trim();
  if (!vg || vg.startsWith('__kit_')) return `Вариант ${index + 1}`;
  return vg;
}
