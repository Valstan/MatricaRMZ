/**
 * Разбор дублей двигателей: два режима и никаких кластеров (владелец 18.11.2026).
 *
 * Кластер-склейка номеров (union-find по транзитивной близости) на живых данных
 * давала группы по 1478 РАЗНЫХ двигателей одного заказчика: номера завода идут
 * подряд, и «расстояние ≤2 правок» ничего не различало. Оператору такое
 * предлагать нельзя — склейка такой группы отняла бы у завода сотни карточек.
 *
 * Сторож держит три вещи: кластер не вернётся, режим доезжает от кнопки до
 * сервера, а похожие пары считаются по правилу, а не «как попало».
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const read = (rel: string) => readFileSync(join(repo, rel), 'utf8');

const SERVICE = read('backend-api/src/services/engineDedupeService.ts');
const ROUTE = read('backend-api/src/routes/engines.ts');
const PRELOAD = read('electron-app/src/preload/index.ts');
const IPC = read('electron-app/src/main/ipc/register/enginesOpsAudit.ts');
const CONTRACT = read('shared/src/ipc/types.ts');

describe('разбор дублей двигателей — режимы «По номеру» / «Похожие»', () => {
  it('кластер-склейки номеров больше нет', () => {
    // union-find по транзитивной близости — источник групп по 1478 двигателей.
    expect(SERVICE).not.toContain('const union =');
    expect(SERVICE).not.toContain('damerauLevenshtein');
    expect(SERVICE).not.toContain('clusterKeys');
  });

  it('похожие пары считаются по правилу, а не кластером', () => {
    expect(SERVICE).toContain('findSimilarEnginePairs');
  });

  it('режим доезжает от клиента до сервера', () => {
    expect(CONTRACT).toContain('EngineDedupeMode');
    expect(CONTRACT).toContain("dedupeAnalyze: (args?: { mode?: EngineDedupeMode })");
    expect(PRELOAD).toContain("dedupeAnalyze: async (args?: { mode?: 'exact' | 'similar' })");
    expect(IPC).toContain("args?.mode");
    expect(ROUTE).toContain("req.query.mode === 'similar'");
    expect(SERVICE).toContain("opts?.mode === 'similar'");
  });

  it('ответ разбора отдаёт расхождения полей — оператор видит, что «заполнено по-разному»', () => {
    expect(CONTRACT).toContain('diffFields');
    expect(SERVICE).toContain('diffFields');
  });
});
