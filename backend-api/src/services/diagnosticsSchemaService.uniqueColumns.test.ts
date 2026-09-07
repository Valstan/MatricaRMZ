import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { compareAppVersion } from '@matricarmz/shared';
import { describe, expect, it } from 'vitest';

import { SCHEMA_UNIQUE_SAFE_CLIENT_VERSION, pgArrayColumns } from './diagnosticsSchemaService.js';

describe('SCHEMA_UNIQUE_SAFE_CLIENT_VERSION', () => {
  it('порог отсекает сборки без режима отчёта: не ниже 3.20.0 и не из будущего', () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as { version: string };

    // Порог — исторический: клиенты 3.20.0 и новее по серверным unique только отчитываются,
    // более старые применяют дедуп сразу. Он не обязан расти вместе с версией программы, и
    // прежняя формулировка требовала именно этого: сравнение с `pkg.version` было записано
    // как «не ниже», и первый же следующий релиз (3.21.0) уронил тест на константе, которая
    // ничем не провинилась. Правильных условий два, и оба про сам порог.
    expect(compareAppVersion(SCHEMA_UNIQUE_SAFE_CLIENT_VERSION, '3.20.0')).toBeGreaterThanOrEqual(0);

    // Порог не может указывать на сборку, которой ещё нет: тогда unique не получит НИКТО, и
    // отчёт о расхождениях молча не соберётся ни с одной машины парка.
    expect(compareAppVersion(SCHEMA_UNIQUE_SAFE_CLIENT_VERSION, pkg.version)).toBeLessThanOrEqual(0);
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
