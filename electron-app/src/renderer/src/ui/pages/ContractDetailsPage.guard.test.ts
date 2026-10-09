import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Карточка контракта (баг 10.10.2026): частичное сохранение одной вкладки
// затирало несохранённые другие — «Сохранить реквизиты ГОЗ» стирал заполненное
// «Контракт и ДС» у новой карточки (общий ресид стейта из строки двери +
// безусловный loadContract после записи), и наоборот. Скрепы ниже держат
// инвариант «чужой срез не трогаем» написанием: если кто-то вернёт общий
// ресид — тест покраснеет до того, как оператор потеряет введённое.
function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
}

const PAGE = src('./ContractDetailsPage.tsx');

describe('карточка контракта — частичное сохранение не трогает чужие вкладки', () => {
  it('ответ двери применяется срезово: какие поля слали, те срезы и ресидятся', () => {
    expect(
      PAGE,
      'saveContractFields обязан передавать отправленные поля в applyStrictContractRow',
    ).toContain('applyStrictContractRow(r.row, new Set(Object.keys(fields)))');
    expect(
      PAGE,
      'вернулся общий ресид секций из строки — он затирает несохранённую вкладку',
    ).not.toContain('setSections(parseContractSections(next.attributes))');
  });

  it('кнопка «Бухгалтерии» пишется без перезагрузки карточки', () => {
    expect(PAGE, 'сохранение реквизитов обязано идти с reload: false').toContain(
      'saveAccountingFields({ reload: false })',
    );
  });

  it('вложения перезагружают карточку с сохранением несохранённых правок', () => {
    const hits = PAGE.split('loadContract({ keepUnsavedEdits: true })').length - 1;
    expect(hits, 'оба обработчика вложений (attachments + файловые дефы) обязаны держать флаг').toBe(2);
  });

  it('loadContract умеет сохранять грязные срезы', () => {
    expect(PAGE).toContain('loadContract(opts?: { keepUnsavedEdits?: boolean })');
  });

  it('эффект-ресид бухформы не срабатывает поверх грязной карточки', () => {
    expect(PAGE).toContain('if (dirtyRef.current) return;');
  });

  it('«Сброс» гасит dirty и чистит черновик ДО перезагрузки', () => {
    const norm = PAGE.split('\n')
      .map((line) => line.trim())
      .join('\n');
    const snippet = 'dirtyRef.current = false;\nawait clearDraft();\nawait loadContract();';
    const hits = norm.split(snippet).length - 1;
    expect(hits, 'оба пути сброса (тулбар и close-actions) обязаны гасить dirty до ресида').toBe(2);
  });
});
