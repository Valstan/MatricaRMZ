import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Шаблон подписей ПП по умолчанию (промт КАРМАНА #120, план #121).
//
// Сторож держит четыре вещи:
//  1. шаблон — ССЫЛКА, а не запись в `signature_slots`: трёхзначная семантика поля
//     (`null` — «оператор не трогал блок», `[]` — «снял всё») обязана уцелеть;
//  2. применение шаблона идёт через `setHeader` — иначе теряется автосейв;
//  3. кнопки ведения шаблона — только при праве
//     `production_program.signature_templates.edit`;
//  4. домен шаблона — общий, а не копия в странице ПП.

function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
}

const DOMAIN = src('../../../../../../shared/src/domain/productionProgramSignatureTemplate.ts');
const PAGE = src('../pages/ProductionProgramPage.tsx');
const PREVIEW = src('../components/ProductionProgramPrintPreview.tsx');
const CAPS = src('../auth/permissions.ts');

describe('шаблон подписей ПП по умолчанию', () => {
  it('домен шаблона — общий модуль, страница его не копирует', () => {
    expect(DOMAIN).toContain('export function resolveProductionProgramSignatureTemplate');
    expect(DOMAIN).toContain('export function productionProgramSignatureTemplateSlots(');
    // Состав шаблона разбирается общим правилом слотов.
    expect(DOMAIN).toContain('parsePrintSignatureSlots');
  });

  it('применение шаблона идёт через setHeader — иначе потеряется автосейв', () => {
    expect(PAGE).toContain('applySignatureTemplate');
    expect(PAGE).toContain('setHeader({');
    expect(PAGE).toContain('signatureTemplateId: tpl.id');
    // Правка уходит в PATCH только изменёнными полями.
    expect(PAGE).toContain("sentFields.push('signatureTemplateId')");
  });

  it('сохранить как шаблон по умолчанию — из состава текущей программы', () => {
    expect(PAGE).toContain('saveSignatureTemplateAsDefault');
    expect(PAGE).toContain('saveSignatureTemplate');
    expect(PAGE).toContain('isDefault: true');
  });

  it('кнопки шаблона — только при праве на их ведение', () => {
    expect(CAPS).toContain("'production_program.signature_templates.edit'");
    expect(PREVIEW).toContain('props.canEditTemplates ?');
    // Блок шаблона не показывается вообще, если права нет.
    expect(PREVIEW).toContain('data-pp-signature-template-apply');
    expect(PREVIEW).toContain('data-pp-signature-template-save-default');
  });

  it('шаблон не пишется в то же поле, что и состав', () => {
    // Ссылка — отдельное поле; `signatureSlots` хранит копию состава.
    expect(PAGE).toContain('signatureTemplateId');
    expect(PAGE).not.toContain('signatureSlots: template');
  });
});
