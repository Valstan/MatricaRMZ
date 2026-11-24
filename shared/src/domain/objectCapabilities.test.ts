import { describe, expect, it } from 'vitest';

import {
  OBJECT_CAPABILITIES,
  OBJECT_KINSHIP,
  capabilityOwners,
  objectCapabilities,
  objectHasCapability,
  suggestCapabilityAdditions,
} from './objectCapabilities.js';

/**
 * Каталог действий по объекту — «гибкий модуль кнопок» (промт КАРМАНА #124).
 * Правило, которое тут проверяется: кнопка есть только там, где объект умеет функцию,
 * а подсказка «добавь объекту то, что есть у похожего» не придумывает, а берёт из родства.
 */

describe('каталог возможностей объекта', () => {
  it('у каждого типа объекта есть свой набор возможностей', () => {
    for (const [kind, capabilities] of Object.entries(OBJECT_CAPABILITIES)) {
      expect(capabilities.length, `${kind}: пустой набор возможностей`).toBeGreaterThan(0);
    }
  });

  it('родство объявлено для каждого типа объекта', () => {
    for (const kind of Object.keys(OBJECT_CAPABILITIES) as Array<keyof typeof OBJECT_CAPABILITIES>) {
      expect(OBJECT_KINSHIP[kind], `${kind}: родство не объявлено`).toBeDefined();
      expect(OBJECT_KINSHIP[kind], `${kind}: объект не должен быть своим же родственником`).not.toContain(kind);
    }
  });

  it('«умеет» — это запись в реестре, а не догадка по названию', () => {
    expect(objectHasCapability('work_sheet_row', 'save')).toBe(true);
    expect(objectHasCapability('work_sheet_row', 'print')).toBe(false);
    expect(objectHasCapability('work_sheet_row', 'signatures')).toBe(false);
    expect(objectCapabilities('work_sheet_row')).toContain('delete');
  });

  it('владельцы возможности — все типы объектов, которые её имеют', () => {
    const owners = capabilityOwners('signatures');
    expect(owners).toContain('work_order');
    expect(owners).not.toContain('work_sheet_row');
  });
});

describe('подсказка «объект можно доукомплектовать»', () => {
  it('предлагает только то, чего у объекта нет', () => {
    const suggestions = suggestCapabilityAdditions('work_sheet_row');
    for (const suggestion of suggestions) {
      expect(
        objectHasCapability('work_sheet_row', suggestion.capability),
        `«${suggestion.capability}» у объекта уже есть — это не подсказка, а шум`,
      ).toBe(false);
    }
  });

  it('подсказка ссылается только на родственников объекта', () => {
    const suggestions = suggestCapabilityAdditions('work_sheet_row');
    const relatives = new Set(OBJECT_KINSHIP.work_sheet_row);
    for (const suggestion of suggestions) {
      for (const owner of suggestion.owners) {
        expect(relatives.has(owner), `${owner} не родственник work_sheet_row`).toBe(true);
        expect(objectHasCapability(owner, suggestion.capability)).toBe(true);
      }
    }
  });

  it('подсказка непустая: у этапа работ есть чему научиться у наряда', () => {
    const suggestions = suggestCapabilityAdditions('work_sheet_row');
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions.some((s) => s.owners.includes('work_order'))).toBe(true);
  });

  it('подсказка не выдумывает: каждое предложение принадлежит кому-то из родственников', () => {
    for (const kind of Object.keys(OBJECT_CAPABILITIES) as Array<keyof typeof OBJECT_CAPABILITIES>) {
      for (const suggestion of suggestCapabilityAdditions(kind)) {
        expect(suggestion.owners.length, `${kind}/${suggestion.capability}: никто не владеет`).toBeGreaterThan(0);
      }
    }
  });
});
