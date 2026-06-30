import type { PartDimension, PartSpec, PartSpecBrandLink } from '@matricarmz/shared';

// Phase 2 Stage E.1: builds the part-spec payload sent to nomenclaturePartSpecUpdate from
// the editable subpanel state. Trims dimension/assembly text, drops empty dimension rows and
// brand-links without a brand, and round-trips `code` untouched (the card's «Код» field owns
// erp_nomenclature.code; directory_parts.code is not edited here).
export function buildPartSpecPayload(args: {
  code: string | null;
  dimensions: PartDimension[];
  brandLinks: PartSpecBrandLink[];
}): PartSpec {
  return {
    code: args.code ?? null,
    dimensions: args.dimensions
      .map((d) => ({ id: d.id, name: d.name.trim(), value: d.value.trim() }))
      .filter((d) => d.name || d.value),
    brandLinks: args.brandLinks
      .filter((b) => b.engineBrandId)
      .map((b) => ({
        id: b.id,
        engineBrandId: b.engineBrandId,
        assemblyUnitNumber: b.assemblyUnitNumber?.trim() || null,
        quantity: Number.isFinite(b.quantity) ? b.quantity : 0,
      })),
  };
}
