import { useEffect, useState } from 'react';

import type { EngineFactoryStageTypeRef } from '@matricarmz/shared';

import { loadWorkSheetTypes } from '../utils/workSheetTypesCache.js';

/**
 * Виды работ как справочник этапов НА ЗАВОДЕ — для ступеней «Этап на заводе» и «Вид работ» списка
 * двигателей и отчётов. Полный ряд нужен, чтобы этап без двигателей всё равно был в фильтре;
 * порядок — `sortOrder` справочника. Сервер, при отказе — кэш; без обоих ступень живёт на том,
 * что несут сами строки.
 */
export function useWorkSheetTypeRefs(): EngineFactoryStageTypeRef[] {
  const [types, setTypes] = useState<EngineFactoryStageTypeRef[]>([]);
  useEffect(() => {
    let alive = true;
    void loadWorkSheetTypes().then((res) => {
      if (!alive) return;
      setTypes(res.rows.map((t) => ({ code: t.code, name: t.name, sortOrder: t.sortOrder })));
    });
    return () => {
      alive = false;
    };
  }, []);
  return types;
}
