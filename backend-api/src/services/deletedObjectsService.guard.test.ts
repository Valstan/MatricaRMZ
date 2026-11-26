import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Сторож «Удалённое за 3 дня» (промт КАРМАНА #169).
 *
 * ПОЧЕМУ СТОРОЖ ПО ИСХОДНИКУ, А НЕ ЮНИТ. Проверяемые тут свойства — не чистая логика,
 * а ДОГОВОРЕНОСТЬ С СОСЕДНИМИ ТАБЛИЦАМИ: автор удаления лежит в журнале действий
 * (`audit_log`), а окончательное удаление обязано оставить в нём след. Юнит-тест на
 * заглушке БД такой договорённости не видит — он проверяет mocks, а не таблицу.
 */
const src = (rel: string) => readFileSync(path.resolve(__dirname, rel), 'utf8').replace(/\r\n/g, '\n');

const SERVICE = src('./deletedObjectsService.ts');

describe('список удалённого показывает, что, когда и кем удалено', () => {
  it('автор удаления берётся из журнала действий', () => {
    // Своей колонки «кто удалил» у мягко удалённых строк нет — истина одна, журнал.
    expect(SERVICE, 'список не знает автора удаления').toContain('resolveDeleteActors');
    expect(SERVICE, 'автор удаления ищется в журнале действий').toContain('from(auditLog)');
    expect(SERVICE, 'строка списка несёт автора удаления').toContain('deletedBy');
  });

  it('автор удаления — последняя строка удаления по времени', () => {
    const fn = SERVICE.slice(SERVICE.indexOf('async function resolveDeleteActors'), SERVICE.indexOf('/**\n * Имя объекта для следа'));
    expect(fn, 'функции разбора автора нет').not.toBe('');
    expect(fn, 'строка удаления опознаётся по коду действия').toContain("action.includes('delete')");
  });
});

describe('окончательное удаление оставляет след в журнале', () => {
  it('перед удалением строки пишется строка «удалил окончательно»', () => {
    const fn = SERVICE.slice(SERVICE.indexOf('async function writePurgeAudit'), SERVICE.indexOf('/**\n * Имя объекта для следа'));
    expect(fn, 'следа в журнале нет').not.toBe('');
    expect(fn, 'след пишется в журнал действий').toContain('insert(auditLog)');
    expect(fn, 'код следа понятен подписи').toContain("'deleted.purge'");
  });

  it('след пишется ДО удаления — иначе имя объекта уже не взять', () => {
    const fn = SERVICE.slice(SERVICE.indexOf('export async function purgeDeletedObject'), SERVICE.indexOf('/**\n * «Посмотреть»'));
    const traceAt = fn.indexOf('writePurgeAudit(');
    const deleteAt = fn.indexOf('db.delete(');
    expect(traceAt, 'следа в журнале нет').toBeGreaterThan(-1);
    expect(deleteAt, 'удаления нет').toBeGreaterThan(-1);
    expect(traceAt, 'след пишется ПОСЛЕ удаления — имя объекта уже потеряно').toBeLessThan(deleteAt);
  });
});

describe('правило «храним три дня»', () => {
  it('старше срока убираются и файлы', () => {
    const fn = SERVICE.slice(SERVICE.indexOf('export async function purgeExpiredDeletedObjects'));
    expect(fn, 'уборка не трогает файлы, а файлы — вид из реестра удалений').toContain('fileAssets');
    expect(fn, 'файлы старше срока не удаляются').toContain('lt(fileAssets.deletedAt, since)');
  });
});

describe('восстановление возвращает путь', () => {
  it('путь возврата считается по имени, а не повторным списком', () => {
    // Повторный запрос списка после снятия метки ничего не нашёл бы: записи в списке
    // удалённых уже нет, и оператор остался бы без пути «Двигатели → Д-100».
    const fn = SERVICE.slice(SERVICE.indexOf('export async function restoreDeletedObject'), SERVICE.indexOf('/**\n * Удалить окончательно'));
    expect(fn, 'путь возврата не считается по имени').toContain('deletedObjectRestorePath(kind, res.name)');
  });
});
