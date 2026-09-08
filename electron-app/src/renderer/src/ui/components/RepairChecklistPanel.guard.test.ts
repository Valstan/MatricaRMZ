import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Сторож двух молчаливых потерь данных в акте (оба чинились 2026-09-08).
//
// Строка листа пересобирается из шаблона марки при каждом открытии карточки
// (brand-resync). Операторские поля переживают его только потому, что merge-коллбек
// переносит их из prev поимённо: у строки марки этих полей нет, и забытое поле
// стирается тихо — типы и линт целы, а введённый текст исчезает к следующему заходу.
// Ровно так пропадала «причина утиля».
//
// Шапка акта досыпается из карточки двигателя, которая шлёт пропсы на каждое нажатие.
// Признаком «поле ничьё» когда-то была пустота — и в акт уезжала первая буква номера.
// Правило владения живёт в домене (`resolveHeaderAutofill`, покрыт своим тестом);
// здесь сторожится только то, что панель им пользуется и помнит владение в ref.

function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
}

const PANEL = src('./RepairChecklistPanel.tsx');

describe('RepairChecklistPanel: операторские данные переживают brand-resync', () => {
  it('merge-коллбек engine_inventory переносит scrap_reason из прежней строки', () => {
    expect(PANEL).toContain("? { scrap_reason: String((prev as any).scrap_reason) }");
  });

  it('переносит и остальные операторские поля строки', () => {
    for (const field of ['stamped_number', 'replenishment_branch', 'scrap_qty', 'replace_qty']) {
      expect(PANEL).toContain(field);
    }
  });
});

describe('RepairChecklistPanel: автоподстановка шапки', () => {
  it('решение о записи принимает доменная функция, а не проверка «поле пустое»', () => {
    expect(PANEL).toContain('resolveHeaderAutofill({');
    expect(PANEL).toContain('owned: headerAutofillRef.current[id],');
  });

  it('запоминает своё значение, чтобы догонять карточку при вводе по буквам', () => {
    expect(PANEL).toContain('headerAutofillRef.current[id] = resolved;');
  });

  it('сбрасывает владение при перезагрузке листа', () => {
    expect(PANEL).toContain('headerAutofillRef.current = {};');
  });
});
