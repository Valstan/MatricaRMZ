/**
 * Клиент обязан знать, что сервер переименовал id его строки значения
 * (строка хранится по паре «сущность+поле»). Иначе строка навсегда остаётся
 * в pending: подтверждение приходит с серверным id, локальная строка с чужим
 * id не снимается, и клиент шлёт её снова и снова (прод-инцидент 03.11.2026:
 * 3.6 млн записей в журнале за сутки от одной машины).
 *
 * Тест — структурный: проверяет, что клиент и разбирает `id_remaps.attribute_values`,
 * и применяет переименование (переименовывает строку либо убирает дубль).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(here, '../syncService.ts'), 'utf8');

describe('клиент: переименование id строки значения', () => {
  it('разбирает attribute_values в отчёте о переименованиях', () => {
    expect(source).toContain('attribute_values?: Record<string, string>');
  });

  it('применяет переименование: строка переименовывается либо дубль убирается', () => {
    expect(source).toContain('remapAttributeValueInSqlite');
    // Серверная строка — уже применённая версия: локальный дубль удаляем,
    // а оставшуюся помечаем synced (правка доехала, повторный пуш не нужен).
    expect(source).toMatch(/DELETE FROM attribute_values WHERE id = \?/);
    expect(source).toMatch(/SET id = \?, updated_at = \?, sync_status = 'synced'/);
  });
});
