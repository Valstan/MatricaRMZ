import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Сторож правила «у удалённого объекта ссылка отсутствует» (промт КАРМАНА #169).
 *
 * ПОЧЕМУ СТОРОЖ ПО ИСХОДНИКУ. Проверяемое свойство — ДОГОВОРЕННОСТЬ С ТАБЛИЦАМИ: удаление
 * мягкое, метка `deletedAt` живёт в своей таблице у каждого вида объекта, а строка журнала
 * знает только `tableName`. Юнит-тест на заглушке БД такой договорённости не видит.
 */
const src = (rel: string) => readFileSync(path.resolve(__dirname, rel), 'utf8').replace(/\r\n/g, '\n');

const SERVICE = src('./auditObjectService.ts');
const STATS = src('./statisticsAuditService.ts');

describe('удалённый объект строки журнала опознаётся по своей таблице', () => {
  it('жёсткие таблицы проверяются по метке удаления', () => {
    const fn = SERVICE.slice(SERVICE.indexOf('async function deletedIdsInStrictTable'));
    expect(fn, 'проверки строгих таблиц нет').not.toBe('');
    expect(fn, 'метка удаления не проверяется').toContain('isNotNull(');
  });

  it('заявки, договоры, контрагенты, файлы и детали в списке строк', () => {
    const set = SERVICE.slice(SERVICE.indexOf('const STRICT_DELETED_TABLES'));
    expect(set, 'реестра строгих таблиц нет').not.toBe('');
    for (const table of [
      'operations',
      'erp_contracts',
      'erp_counterparties',
      'erp_engine_cards',
      'erp_employee_cards',
      'directory_parts',
      'directory_tools',
      'erp_document_headers',
      'file_assets',
    ]) {
      expect(set, `таблицы «${table}» нет в реестре`).toContain(`'${table}'`);
    }
  });

  it('таблица строки берётся из строки журнала, а не перебирается подряд', () => {
    const fn = SERVICE.slice(SERVICE.indexOf('export async function resolveDeletedObjectIds'));
    expect(fn, 'таблица строки не читается').toContain('row.tableName');
    expect(fn, 'ids собираются по таблицам').toContain('idsByTable');
  });

  it('в выдаче журнала оба признака удаления объединены', () => {
    // Джойн по `entities` ловит только EAV; строгие таблицы — отдельной проверкой.
    // Если вторая половина пропала, у удалённого договора осталась бы живая ссылка.
    expect(STATS, 'жёсткие таблицы не проверяются при выдаче журнала').toContain('resolveDeletedObjectIds');
    expect(STATS, 'признаки удаления не объединены').toContain('strictDeleted.has(');
  });
});

describe('раздел и имя объекта считаются на показе', () => {
  it('выдача журнала считает раздел заново, а не берёт записанный', () => {
    // Материализованная колонка заполняется один раз при инжесте: у старых строк в ней
    // навсегда «Прочее». Показ считает раздел заново — тогда в живом журнале «Прочее»
    // нет, а текст действия старых строк остаётся прежним (прошлое не переиграть).
    const fn = STATS.slice(STATS.indexOf('export async function listAuditStatistics'));
    expect(fn, 'раздел на показе не считается').toContain('resolveAuditObjectInfo');
    expect(fn, 'посчитанный раздел не предпочитается записанному').toContain('info?.section || row.section');
    expect(fn, 'имя объекта на показе не считается').toContain('info?.objectName || row.documentLabel');
  });
});
