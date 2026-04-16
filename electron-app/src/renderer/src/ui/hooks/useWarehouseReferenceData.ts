import { useCallback, useEffect, useState } from 'react';
import type { WarehouseLookups, WarehouseNomenclatureListItem } from '@matricarmz/shared';

const EMPTY_LOOKUPS: WarehouseLookups = {
  warehouses: [],
  nomenclatureGroups: [],
  units: [],
  writeoffReasons: [],
  counterparties: [],
  employees: [],
  engineBrands: [],
};

export function useWarehouseReferenceData(options?: { loadNomenclature?: boolean }) {
  const [lookups, setLookups] = useState<WarehouseLookups>(EMPTY_LOOKUPS);
  const [nomenclature, setNomenclature] = useState<WarehouseNomenclatureListItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const lookupsRes = await window.matrica.warehouse.lookupsGet();
      if (!lookupsRes?.ok) {
        setError(String(lookupsRes?.error ?? 'Не удалось загрузить складские справочники'));
        return;
      }
      setLookups(lookupsRes.lookups);
      if (options?.loadNomenclature) {
        const pageSize = 500;
        let offset = 0;
        const merged: WarehouseNomenclatureListItem[] = [];
        while (true) {
          const nomenclatureRes = await window.matrica.warehouse.nomenclatureList({
            isActive: true,
            limit: pageSize,
            offset,
          });
          if (!nomenclatureRes?.ok) {
            setError(String(nomenclatureRes?.error ?? 'Не удалось загрузить номенклатуру'));
            return;
          }
          const batch = nomenclatureRes.rows ?? [];
          merged.push(...(batch as WarehouseNomenclatureListItem[]));
          if (!nomenclatureRes.hasMore || batch.length === 0) break;
          offset += pageSize;
          if (offset > 2_000_000) break;
        }
        setNomenclature(merged);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [options?.loadNomenclature]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return {
    lookups,
    nomenclature,
    loading,
    error,
    refresh,
  };
}
