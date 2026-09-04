import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { compareAppVersion } from '@matricarmz/shared';
import { describe, expect, it } from 'vitest';

import { SCHEMA_UNIQUE_SAFE_CLIENT_VERSION, pgArrayColumns } from './diagnosticsSchemaService.js';

describe('SCHEMA_UNIQUE_SAFE_CLIENT_VERSION', () => {
  it('не ниже версии, в которой клиент получил режим отчёта (3.20.0): более старые сборки удаляют по unique сразу', () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as { version: string };
    // Пока 3.20.0 не выпущена, константа строго выше текущего VERSION; после выпуска — равна ей или ниже.
    expect(compareAppVersion(SCHEMA_UNIQUE_SAFE_CLIENT_VERSION, '3.20.0')).toBeGreaterThanOrEqual(0);
    expect(compareAppVersion(SCHEMA_UNIQUE_SAFE_CLIENT_VERSION, pkg.version)).toBeGreaterThanOrEqual(
      compareAppVersion('3.20.0', pkg.version) > 0 ? 1 : 0,
    );
  });
});

// Снимок схемы едет на клиент, и по uniqueConstraints ремонт реплики СХЛОПЫВАЕТ дубли.
// До 2026-09-04 array_agg(name) приезжал строкой "{code}", потребитель требовал массив и
// выбрасывал каждую запись — сторож был мёртв с рождения. Обе формы обязаны разбираться.

describe('pgArrayColumns', () => {
  it('разобранный драйвером массив — как есть', () => {
    expect(pgArrayColumns(['code', 'brand_id'])).toEqual(['code', 'brand_id']);
    expect(pgArrayColumns([' code ', '', null])).toEqual(['code']);
  });

  it('неразобранный name[] в текстовой форме "{a,b}" — тоже список, а не пусто', () => {
    expect(pgArrayColumns('{code}')).toEqual(['code']);
    expect(pgArrayColumns('{brand_id,code}')).toEqual(['brand_id', 'code']);
    expect(pgArrayColumns('{"quoted name",plain}')).toEqual(['quoted name', 'plain']);
  });

  it('мусор — пусто, без падения', () => {
    expect(pgArrayColumns(null)).toEqual([]);
    expect(pgArrayColumns('code')).toEqual([]);
    expect(pgArrayColumns('{}')).toEqual([]);
  });
});
