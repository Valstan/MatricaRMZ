import { CUSTOM_REPORT_TEMPLATES_LIMIT, type CustomReportTemplate } from '@matricarmz/shared';
import { describe, expect, it } from 'vitest';

import { findTemplate, listTemplates, removeTemplate, upsertTemplate } from './customReportTemplatesBucket.js';

function tpl(id: string, name: string, over: Partial<CustomReportTemplate> = {}): CustomReportTemplate {
  return { id, name, createdAt: 1, spec: { version: 1, sourcePresetId: 'engines_list', columns: [], filters: [] }, ...over };
}

// Строка, которую сегодняшний санитайзер не понимает: источник переименован.
const alien = { id: 'crt_old', name: 'Старый разрез', createdAt: 5, spec: { version: 1, sourcePresetId: 'renamed_source', columns: ['x'], filters: [] } };

describe('upsertTemplate', () => {
  it('сохранение своего шаблона не выбрасывает соседей, которых санитайзер не понимает', () => {
    const r = upsertTemplate([tpl('a', 'A'), alien], tpl('b', 'B'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.bucket.map((x) => x.id)).toEqual(['b', 'a', 'crt_old']);
    expect(r.bucket[2]).toBe(alien); // байт в байт, та же ссылка
  });

  it('замена по id или по имени, новый — в начало', () => {
    const byId = upsertTemplate([tpl('a', 'A'), tpl('b', 'B')], tpl('a', 'A2'));
    expect(byId.ok && byId.bucket.map((x) => `${x.id}:${x.name}`)).toEqual(['a:A2', 'b:B']);
    const byName = upsertTemplate([tpl('a', 'A'), tpl('b', 'B')], tpl('c', 'B'));
    expect(byName.ok && byName.bucket.map((x) => x.id)).toEqual(['c', 'a']);
  });

  it('лимит — отказ, а не усечение хвоста', () => {
    const full = Array.from({ length: CUSTOM_REPORT_TEMPLATES_LIMIT }, (_, i) => tpl(`t${i}`, `T${i}`));
    const r = upsertTemplate(full, tpl('new', 'New'));
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining('предел') });
    // Пересохранение существующего в полном бакете — не превышение.
    expect(upsertTemplate(full, tpl('t3', 'T3')).ok).toBe(true);
  });

  it('мусор вместо бакета — пустой бакет, не падение', () => {
    expect(upsertTemplate(null, tpl('a', 'A'))).toMatchObject({ ok: true, bucket: [expect.objectContaining({ id: 'a' })] });
    expect(upsertTemplate('garbage', tpl('a', 'A')).ok).toBe(true);
    expect(upsertTemplate([null, 3, 'x', tpl('z', 'Z')], tpl('a', 'A'))).toMatchObject({ ok: true, bucket: [expect.anything(), expect.objectContaining({ id: 'z' })] });
  });
});

describe('removeTemplate', () => {
  it('снимает ровно одну строку, чужие непонятые остаются', () => {
    const r = removeTemplate([tpl('a', 'A'), alien, tpl('b', 'B')], 'a');
    expect(r.removed).toBe(true);
    expect(r.bucket.map((x) => x.id)).toEqual(['crt_old', 'b']);
  });
  it('нет такого id — ничего не меняется', () => {
    const r = removeTemplate([tpl('a', 'A'), alien], 'nope');
    expect(r.removed).toBe(false);
    expect(r.bucket).toHaveLength(2);
  });
});

describe('listTemplates / findTemplate', () => {
  it('для показа непонятые строки пропускаются, но только для показа', () => {
    expect(listTemplates([tpl('a', 'A'), alien]).map((t) => t.id)).toEqual(['a']);
    expect(findTemplate([tpl('a', 'A'), alien], { name: 'A' })?.id).toBe('a');
    expect(findTemplate([alien], { id: 'crt_old' })).toBeNull();
  });
});
