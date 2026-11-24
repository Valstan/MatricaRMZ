import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Промт владельца 24.11.2026: «выбор цеха происходит не из базы, а это неправильно,
// надо чтобы цех выбирался из базы, чтобы потом искать и фильтровать и статистику
// отравлять удобнее было по цехам».
//
// Что это значит в коде:
//   · поле «Цех» в шапке — ВЫБОР из справочника `directory_workshops`, а не свободный
//     текст;
//   · связь хранится ПО ID (`workshop_id`) — по тексту ни поиск, ни фильтр, ни
//     статистика по цехам не поедут;
//   · `shop` остаётся СНИМКОМ имени — на печати и в выгрузке он идёт как в образце
//     («Цех № 1»), даже если цех переименуют.
//
// Сторож по тексту (как остальные гарды страницы): экран собирается из компонентов,
// а проверять надо ИМЕННО форму — иначе правка тихо вернёт свободный текст, и это
// увидит только оператор.
function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
}

const PAGE = src('./ProductionProgramPage.tsx');
const SHARED = src('../../../../../../shared/src/domain/productionProgram.ts');

/** Блок поля «Цех» в шапке. */
function shopFieldBlock(): string {
  const start = PAGE.indexOf("'Цех',");
  expect(start).toBeGreaterThan(-1);
  const end = PAGE.indexOf("{ flex: '1 1 170px' }", start);
  expect(end).toBeGreaterThan(start);
  return PAGE.slice(start, end);
}

describe('ПП: цех выбирается из справочника, а не вводится текстом (промт 24.11.2026)', () => {
  it('поле «Цех» — список, а не текстовое поле', () => {
    const block = shopFieldBlock();
    expect(block).toContain('<select');
    expect(block).not.toContain('<input');
    expect(block).toContain('shopOptions.map');
    expect(block).toContain('applyWorkshopChoice');
  });

  it('в шапке носится связь по id вместе со снимком имени', () => {
    expect(PAGE).toContain('workshopId: string | null');
    expect(PAGE).toContain('workshopId: next.workshopId == null ? null : String(next.workshopId)');
    // Связь едет в правке шапки — но только когда оператор правил цех: в PATCH
    // уходят те поля, которые правлены (иначе правка названия уносила бы с собой
    // подписи — 24.11.2026).
    expect(PAGE).toContain('args.workshopId = h.workshopId;');
    expect(PAGE).toContain('workshopId: selected.workshopId ?? null,');
  });

  it('выбор цеха кладёт и id, и имя (печать получает снимок сразу)', () => {
    expect(PAGE).toContain('setHeader({ workshopId: chosen.id, shop: chosen.label });');
  });

  it('программы, заведённые до связи, не теряются: их цех виден отдельной строкой', () => {
    expect(PAGE).toContain('LEGACY_SHOP_VALUE');
    expect(PAGE).toContain('не из справочника');
    expect(PAGE).toContain('legacyShopText');
  });

  it('контракт клиента знает про связь (иначе реплика её не привезёт)', () => {
    expect(SHARED).toMatch(/export type ProductionProgramDto = \{[\s\S]*?workshopId: string \| null;/);
    expect(SHARED).toMatch(/export type ProductionProgramSaveDto = \{[\s\S]*?workshopId\?: string \| null;/);
  });
});
