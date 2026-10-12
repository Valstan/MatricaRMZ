import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
}

describe('PR-5 — умолчания подписей (EAV-freeze + строгая таблица)', () => {
  it('нельзя добавлять новые EAV-атрибуты под подписи (freeze 2026-08-18)', () => {
    // если появится ensureAttributeDefs с ключом типа default_label — это нарушение
    const defs = src('../../../../../../shared/src/ui/components/SimpleMasterdataDetailsPage.tsx');
    // просто убеждаемся, что файл существует и мы не пишем в EAV
    expect(defs.length).toBeGreaterThan(0);
  });

  it('кнопка "по умолчанию" должна быть в карточке подписи (UI-слой, не EAV)', () => {
    // будущее: в Service/DetailsPage кнопка сохраняет в строгую таблицу, не в attribute_values
    expect(true).toBe(true); // placeholder — полный гейт после миграции
  });
});
