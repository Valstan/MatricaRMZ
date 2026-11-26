import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Вид двигателя: обязателен при заведении и переопределяется появлением договора
 * (промты КАРМАНА #36 + #37, владелец 18.11.2026).
 *
 * Требование владельца распалось на две части, и обе ломаются тихо:
 *
 *  1. **новый двигатель нельзя сохранить без вида** — договор выбран (вид из него) либо
 *     оператор поставил вид руками. Проверка обязана быть в ЕДИНСТВЕННОЙ двери записи
 *     карточки (`saveEngineCardGated`), а не в форме: у карточки два входа (карточка и
 *     пачечный приём), и проверка в форме обошлась бы пачкой (класс brain G363);
 *  2. **появился договор — вид переопределился сам**, везде: в списке, в отчёте, в
 *     карточке, в фильтре. Это свойство ВЫЧИСЛЯЕМОГО значения (общее правило
 *     `resolveEngineKind`), а не фоновая переписка поля: переписыватель конфликтовал бы
 *     с ручным значением и ломал бы историю.
 *
 * Сторож ловит именно тихое: гейт уехал в форму, вид начали читать из ручного поля
 * мимо общего правила, строгость применили к правке старой карточки.
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

function read(rel: string): string {
  return readFileSync(path.join(repoRoot, rel), 'utf8');
}

const KIND_DOMAIN = read('shared/src/domain/engineKind.ts');
const CARD_WRITE = read('electron-app/src/main/services/engineCardWrite.ts');
const ENGINE_SERVICE = read('electron-app/src/main/services/engineService.ts');
const BULK_SERVICE = read('electron-app/src/main/services/engineBulkIntakeService.ts');
const BULK_DIALOG = read('electron-app/src/renderer/src/ui/components/EngineBulkIntakeDialog.tsx');
const ENGINE_PAGE = read('electron-app/src/renderer/src/ui/pages/EngineDetailsPage.tsx');
const ENGINES_PAGE = read('electron-app/src/renderer/src/ui/pages/EnginesPage.tsx');
const REPORT_PAGE = read('electron-app/src/renderer/src/ui/pages/reports/EnginesReportPage.tsx');
const FACETS = read('shared/src/domain/engineListFacets.ts');
// Слой вида в списках (промт КАРМАНА #163): ступень «Вид» и её значения живут здесь, а
// списки берут её общим конструктором — иначе у каждого списка своя ступень со своим рядом.
const KIND_LIST = read('shared/src/domain/engineKindList.ts');

describe('вид двигателя: обязателен при заведении, переопределяется договором', () => {
  it('правило гейта живёт в домене и спрашивает договор, потом ручное значение', () => {
    expect(KIND_DOMAIN).toContain('export function engineKindRequirement');
    expect(KIND_DOMAIN).toMatch(/parseContractKind\(sources\?\.contractKind\)[\s\S]{0,300}parseContractKind\(sources\?\.cardKind\)/);
    expect(KIND_DOMAIN).toContain('ENGINE_KIND_REQUIRED_MESSAGE');
  });

  it('гейт стоит в единственной двери записи карточки — и до deferred-create', () => {
    expect(CARD_WRITE).toContain('engineKindRequirement(');
    expect(CARD_WRITE).toContain('engineEntityExists(db, id)');
    expect(CARD_WRITE).toContain('getContractKindById(db, contractId)');
    // Строгость — только при заведении: правка старой карточки без вида не блокируется.
    expect(CARD_WRITE).toMatch(/if\s*\(!\(await engineEntityExists\(db, id\)\)\)\s*\{/);
    // Гейт ДО создания сущности: отбитая запись не должна оставить призрака-карточку.
    const gateAt = CARD_WRITE.indexOf('engineKindRequirement(');
    const createAt = CARD_WRITE.indexOf('ensureEngineRow(db, id');
    expect(gateAt).toBeGreaterThan(-1);
    expect(createAt).toBeGreaterThan(-1);
    expect(gateAt).toBeLessThan(createAt);
  });

  it('вид двигателя приходит из договора, а не выдумывается', () => {
    expect(ENGINE_SERVICE).toContain('export async function getContractKindById');
    expect(ENGINE_SERVICE).toMatch(/getContractKindById[\s\S]{0,1200}DEFAULT_CONTRACT_KIND/);
  });

  it('пачка идёт через ту же дверь и требует вид до заведения', () => {
    // Второй вход в запись карточки — пачечный приём. Он обязан звать ту же дверь.
    expect(BULK_SERVICE).toContain('saveEngineCardGated(deps, engineId, fields)');
    expect(BULK_SERVICE).toContain('ENGINE_KIND_REQUIRED_MESSAGE');
    // Отказ ДО заведения: половина пачки без вида — не «принято наполовину».
    const checkAt = BULK_SERVICE.indexOf('ENGINE_KIND_REQUIRED_MESSAGE');
    const createAt = BULK_SERVICE.indexOf('saveEngineCardGated(deps, engineId, fields)');
    expect(checkAt).toBeGreaterThan(-1);
    expect(checkAt).toBeLessThan(createAt);
  });

  it('вид везде считается по общему правилу, а не читается из ручного поля', () => {
    // Список: вид приходит готовым в строке (общее правило `resolveEngineKind`).
    expect(ENGINE_SERVICE).toContain('resolveEngineKind({ contractKind, cardKind, counterpartyKind })');
    // Отчёт и список берут значение из строки, а не из карточки.
    expect(REPORT_PAGE).toContain('CONTRACT_KIND_LABELS[e.kind]');
    expect(ENGINES_PAGE).toContain('CONTRACT_KIND_LABELS[e.kind]');
    // В списке видно, откуда взялось значение.
    expect(ENGINES_PAGE).toContain('ENGINE_KIND_SOURCE_LABELS[e.kindSource ?? \'none\']');
  });

  it('карточка показывает вид из договора и предупреждает, что ручное значение перекроется', () => {
    expect(ENGINE_PAGE).toContain('data-engine-kind-value={contractKind}');
    expect(ENGINE_PAGE).toContain('перекроется договором');
    // Новый двигатель без вида — предупреждение до сохранения, а не после отказа.
    expect(ENGINE_PAGE).toContain('data-engine-kind-required');
  });

  it('в пачке вид выбирается, когда договора нет, и не спрашивается, когда он есть', () => {
    expect(BULK_DIALOG).toContain('data-bulk-intake-kind-option');
    expect(BULK_DIALOG).toContain('data-bulk-intake-kind-from-contract');
    expect(BULK_DIALOG).toContain('engineKind: engineKind || null');
  });

  it('двигатели без вида отбираются отдельным значением, а не молча выпадают', () => {
    // Значение «вид не задан» и его подпись живут в общем слое вида в списках (промт
    // КАРМАНА #163), а ступень списка двигателей берёт их оттуда общим конструктором.
    expect(KIND_LIST).toContain('ENGINE_KIND_NONE_VALUE');
    expect(KIND_LIST).toContain("ENGINE_KIND_NONE_LABEL = 'Вид не задан'");
    expect(FACETS, 'ступень «Вид» построена общим конструктором').toContain('engineKindFacetDescriptor');
  });
});
