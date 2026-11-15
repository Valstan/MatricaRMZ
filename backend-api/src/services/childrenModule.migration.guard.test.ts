import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { erpEmployeeChildren, erpGiftRecords, erpOrgEvents } from '../database/schema.js';

// Детский и организационный модуль: миграция 0130 есть, создаёт все три таблицы,
// числится в журнале drizzle и совпадает с drizzle-схемой (иначе db:migrate и код разъедутся).
const drizzleDir = fileURLToPath(new URL('../../drizzle/', import.meta.url));

describe('миграция children_and_organization (0130)', () => {
  const file = readdirSync(drizzleDir).find((f) => f.endsWith('_children_and_organization.sql'));
  const sql = file ? readFileSync(join(drizzleDir, file), 'utf8').replace(/\r\n/g, '\n') : '';

  it('файл существует и создаёт все три таблицы', () => {
    expect(file).toBe('0130_children_and_organization.sql');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS erp_employee_children (');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS erp_org_events (');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS erp_gift_records (');
  });

  it('транспорт зеркала на месте: sync_status и last_server_seq', () => {
    expect(sql).toContain('sync_status text NOT NULL DEFAULT');
    expect(sql).toContain('last_server_seq bigint');
  });

  it('возраст в таблице не хранится — только дата рождения', () => {
    // Возраст считается в домене: хранить его значило бы завести вторую правду.
    expect(sql).not.toMatch(/age\s+(integer|bigint)/);
    expect(sql).toContain('birth_date bigint');
  });

  it('получатель подарка — ссылка, а не свободный текст', () => {
    expect(sql).toContain('recipient_child_id uuid');
    expect(sql).toContain('recipient_employee_id uuid');
  });

  it('числится в журнале drizzle с ростом idx', () => {
    const journal = JSON.parse(readFileSync(join(drizzleDir, 'meta', '_journal.json'), 'utf8')) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    expect(journal.entries.find((e) => e.tag === '0130_children_and_organization')).toBeTruthy();
    const idxs = journal.entries.map((e) => e.idx);
    expect(idxs).toEqual([...idxs].sort((a, b) => a - b));
    expect(new Set(idxs).size).toBe(idxs.length);
  });

  it('drizzle-схема экспортирует те же три таблицы', () => {
    expect(erpEmployeeChildren).toBeTruthy();
    expect(erpOrgEvents).toBeTruthy();
    expect(erpGiftRecords).toBeTruthy();
  });
});
