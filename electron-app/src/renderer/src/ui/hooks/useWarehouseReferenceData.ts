import { useCallback, useEffect, useState } from 'react';
import type { WarehouseLookups, WarehouseNomenclatureListItem } from '@matricarmz/shared';

const EMPTY_LOOKUPS: WarehouseLookups = {
  warehouses: [],
  nomenclatureGroups: [],
  units: [],
  writeoffReasons: [],
  counterparties: [],
  employees: [],
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
      const [lookupsRes, nomenclatureRes] = await Promise.all([
        window.matrica.warehouse.lookupsGet(),
        options?.loadNomenclature ? window.matrica.warehouse.nomenclatureList({ isActive: true }) : Promise.resolve(null),
      ]);
      if (!lookupsRes?.ok) {
        setError(String(lookupsRes?.error ?? 'Не удалось загрузить складские справочники'));
        return;
      }
      setLookups(lookupsRes.lookups);
      if (options?.loadNomenclature) {
        if (!nomenclatureRes?.ok) {
          setError(String(nomenclatureRes?.error ?? 'Не удалось загрузить номенклатуру'));
          return;
        }
        setNomenclature(nomenclatureRes.rows ?? []);
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
