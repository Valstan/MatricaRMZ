import { describe, expect, it } from 'vitest';

import {
  buildPartMetadataBlob,
  buildPartSpecColumns,
  isKnownPartCode,
  serializePartMetadataBlob,
  type PartCustomDefMap,
} from '../services/partFieldMirror.js';

// Pure EAV → directory_parts mapping (Phase 3). Values mimic how the legacy `parts`
// EAV stores them: `attribute_values.value_json` is JSON-encoded text.
const j = (v: unknown) => JSON.stringify(v);

describe('buildPartSpecColumns', () => {
  it('maps name/article/part_template_id/dimensions to the typed spec columns', () => {
    const spec = buildPartSpecColumns({
      name: j('ШАТУН'),
      article: j('ART-1'),
      part_template_id: j('tpl-1'),
      dimensions: j([{ id: 'd1', name: 'L', value: '10' }]),
    });
    expect(spec.name).toBe('ШАТУН');
    expect(spec.code).toBe('ART-1');
    expect(spec.templateId).toBe('tpl-1');
    expect(JSON.parse(spec.dimensionsJson!)).toEqual([{ id: 'd1', name: 'L', value: '10' }]);
  });

  it('returns nulls when fields are absent or empty', () => {
    expect(buildPartSpecColumns({})).toEqual({
      name: null,
      code: null,
      templateId: null,
      dimensionsJson: null,
    });
    // empty dimensions array → null, not "[]"
    expect(buildPartSpecColumns({ name: j('X'), dimensions: j([]) }).dimensionsJson).toBeNull();
  });
});

describe('buildPartMetadataBlob', () => {
  const defs: PartCustomDefMap = new Map([
    ['color', { code: 'color', name: 'Цвет', dataType: 'text', sortOrder: 5 }],
  ]);

  it('maps the typed metadata fields', () => {
    const meta = buildPartMetadataBlob(
      {
        description: j('описание'),
        assembly_unit_number: j('AU-7'),
        engine_node_id: j('node-1'),
        purchase_date: j(1700000000000),
        supplier_id: j('s1'),
        supplier: j('Старый поставщик'),
        contract_id: j('c1'),
        drawings: j([{ id: 'f1', name: 'draw.pdf', mimeType: 'application/pdf', size: 10 }]),
      },
      defs,
    );
    expect(meta.description).toBe('описание');
    expect(meta.assemblyUnitNumber).toBe('AU-7');
    expect(meta.engineNodeId).toBe('node-1');
    expect(meta.purchaseDate).toBe(1700000000000);
    expect(meta.supplierId).toBe('s1');
    expect(meta.supplierLegacy).toBe('Старый поставщик');
    expect(meta.contractId).toBe('c1');
    expect(meta.drawings).toHaveLength(1);
  });

  it('maps status flags and status dates', () => {
    const meta = buildPartMetadataBlob(
      {
        status_repaired: 'true',
        status_repaired_date: j(1700000000001),
        status_rejected: 'false',
      },
      defs,
    );
    expect(meta.statusFlags).toEqual({ status_repaired: true });
    expect(meta.statusDates).toEqual({ status_repaired: 1700000000001 });
  });

  it('routes unknown attributes to custom + customDefs (per-part, Решение B)', () => {
    const meta = buildPartMetadataBlob({ color: j('красный'), name: j('Деталь'), article: j('A-9') }, defs);
    expect(meta.custom).toEqual({ color: 'красный' });
    expect(meta.customDefs).toEqual([{ code: 'color', name: 'Цвет', dataType: 'text', sortOrder: 5 }]);
    // spec codes never leak into custom
    expect(meta.custom).not.toHaveProperty('name');
    expect(meta.custom).not.toHaveProperty('article');
  });

  it('emits custom without customDefs when no def is registered for the code', () => {
    const meta = buildPartMetadataBlob({ weight: j('5кг') }, new Map());
    expect(meta.custom).toEqual({ weight: '5кг' });
    expect(meta.customDefs).toBeUndefined();
  });

  it('returns an empty blob for a part with no residual fields', () => {
    expect(buildPartMetadataBlob({ name: j('X'), article: j('A') }, defs)).toEqual({});
  });
});

describe('serializePartMetadataBlob', () => {
  it('returns null for an empty blob (never "{}")', () => {
    expect(serializePartMetadataBlob({})).toBeNull();
  });

  it('serializes a non-empty blob to JSON text', () => {
    expect(JSON.parse(serializePartMetadataBlob({ description: 'd' })!)).toEqual({ description: 'd' });
  });
});

describe('isKnownPartCode', () => {
  it('recognizes spec, typed-meta, and status codes; everything else is custom', () => {
    expect(isKnownPartCode('name')).toBe(true);
    expect(isKnownPartCode('article')).toBe(true);
    expect(isKnownPartCode('description')).toBe(true);
    expect(isKnownPartCode('status_repaired')).toBe(true);
    expect(isKnownPartCode('status_repaired_date')).toBe(true);
    expect(isKnownPartCode('color')).toBe(false);
  });
});
