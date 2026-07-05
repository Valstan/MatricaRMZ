import React, { useCallback, useEffect, useMemo, useState } from 'react';

import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';
import { SearchSelect } from '../components/SearchSelect.js';
import type { SearchSelectOption } from '../components/SearchSelect.js';
import { mapEntityRowsToSearchOptions } from '../utils/selectOptions.js';
import { useCardContentIds } from '../hooks/useListDeepFilter.js';
import { matchesQueryInRecord } from '../utils/search.js';

type ServiceRow = {
  id: string;
  name: string;
  unit: string;
  price: number | null;
  engineBrandIds: string[];
  /** В UI используем dirty-state — изменения по сравнению с серверной версией. */
  dirty: boolean;
};

function parseIdArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((x) => String(x ?? '').trim()).filter(Boolean);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return [];
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed.map((x) => String(x ?? '').trim()).filter(Boolean);
    } catch {
      // ignore
    }
  }
  return [];
}

type FilterMode = 'all' | 'bound' | 'universal' | 'other';

/**
 * Экран массового редактирования «спецификации услуг по марке двигателя».
 * Использует тот же атрибут `engine_brand_ids` на услугах, что и карточка услуги
 * (Вариант А из плана), без отдельной таблицы.
 *
 *  - Слева: выбор марки.
 *  - Справа: список услуг с галочкой «отмечена для этой марки».
 *  - Изменения накапливаются в памяти и применяются по кнопке «Сохранить».
 */
export function ServicesByBrandPage(props: {
  canEdit: boolean;
  canView: boolean;
  onOpenService: (serviceId: string) => void;
}) {
  const [brandOptions, setBrandOptions] = useState<SearchSelectOption[]>([]);
  const [selectedBrandId, setSelectedBrandId] = useState<string | null>(null);
  const [services, setServices] = useState<ServiceRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState('');
  const [query, setQuery] = useState('');
  const [filterMode, setFilterMode] = useState<FilterMode>('all');
  const [busy, setBusy] = useState(false);

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const types = await window.matrica.admin.entityTypes.list().catch(() => [] as Array<{ id: string; code: string }>);
      const engineBrandType = (types as Array<{ id: string; code: string }>).find((t) => String(t.code) === 'engine_brand') ?? null;
      const serviceType = (types as Array<{ id: string; code: string }>).find((t) => String(t.code) === 'service') ?? null;

      if (engineBrandType?.id) {
        const rows = await window.matrica.admin.entities.listByEntityType(String(engineBrandType.id));
        const opts = mapEntityRowsToSearchOptions(rows);
        setBrandOptions(opts);
        if (!selectedBrandId && opts[0]) setSelectedBrandId(opts[0].id);
      }

      if (serviceType?.id) {
        const rows = await window.matrica.admin.entities.listByEntityType(String(serviceType.id));
        const details = await Promise.all(
          (rows as Array<{ id: string }>).slice(0, 5000).map(async (row) => {
            const d = await window.matrica.admin.entities.get(String(row.id)).catch(() => null);
            const attrs = (d as { attributes?: Record<string, unknown> } | null)?.attributes ?? {};
            const priceRaw = Number(attrs.price);
            return {
              id: String(row.id),
              name: String(attrs.name ?? row.id),
              unit: String(attrs.unit ?? ''),
              price: Number.isFinite(priceRaw) ? priceRaw : null,
              engineBrandIds: parseIdArray(attrs.engine_brand_ids),
              dirty: false,
            } as ServiceRow;
          }),
        );
        details.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
        setServices(details);
      }
    } finally {
      setLoading(false);
    }
  }, [selectedBrandId]);

  useEffect(() => {
    if (!props.canView) return;
    void loadAll();
  }, [props.canView]);

  const dirtyCount = useMemo(() => services.filter((s) => s.dirty).length, [services]);

  // Верхний поиск: имя + внутрь карточки (EAV).
  const getServiceId = useCallback((s: { id: string }) => String(s.id), []);
  const deepIds = useCardContentIds(services, getServiceId, query);
  const filteredServices = useMemo(() => {
    return services.filter((s) => {
      if (!matchesQueryInRecord(query, { name: s.name }) && !(deepIds?.has(String(s.id)) ?? false)) return false;
      if (!selectedBrandId) return true;
      const isUniversal = s.engineBrandIds.length === 0;
      const isBound = s.engineBrandIds.includes(selectedBrandId);
      switch (filterMode) {
        case 'bound':
          return isBound;
        case 'universal':
          return isUniversal;
        case 'other':
          return !isUniversal && !isBound;
        default:
          return true;
      }
    });
  }, [services, query, deepIds, selectedBrandId, filterMode]);

  function toggleService(serviceId: string) {
    if (!selectedBrandId || !props.canEdit) return;
    setServices((prev) =>
      prev.map((s) => {
        if (s.id !== serviceId) return s;
        const has = s.engineBrandIds.includes(selectedBrandId);
        const next = has
          ? s.engineBrandIds.filter((b) => b !== selectedBrandId)
          : [...s.engineBrandIds, selectedBrandId];
        return { ...s, engineBrandIds: next, dirty: true };
      }),
    );
  }

  function bulkToggle(mode: 'attach' | 'detach') {
    if (!selectedBrandId || !props.canEdit) return;
    const ids = new Set(filteredServices.map((s) => s.id));
    setServices((prev) =>
      prev.map((s) => {
        if (!ids.has(s.id)) return s;
        const has = s.engineBrandIds.includes(selectedBrandId);
        if (mode === 'attach' && !has) {
          return { ...s, engineBrandIds: [...s.engineBrandIds, selectedBrandId], dirty: true };
        }
        if (mode === 'detach' && has) {
          return {
            ...s,
            engineBrandIds: s.engineBrandIds.filter((b) => b !== selectedBrandId),
            dirty: true,
          };
        }
        return s;
      }),
    );
  }

  async function saveChanges() {
    if (busy) return;
    const dirty = services.filter((s) => s.dirty);
    if (dirty.length === 0) return;
    setBusy(true);
    setStatus(`Сохраняю ${dirty.length}…`);
    try {
      const results = await Promise.allSettled(
        dirty.map((s) =>
          window.matrica.admin.entities.setAttr(
            s.id,
            'engine_brand_ids',
            s.engineBrandIds.length > 0 ? s.engineBrandIds : null,
          ),
        ),
      );
      const failed = results.filter((r) => r.status === 'rejected').length;
      if (failed > 0) {
        setStatus(`Ошибки при сохранении: ${failed} из ${dirty.length}`);
      } else {
        setStatus(`Сохранено: ${dirty.length}`);
      }
      // Сбрасываем dirty только для тех, кто сохранился успешно.
      setServices((prev) =>
        prev.map((s) => {
          const di = dirty.indexOf(s);
          if (di < 0) return s;
          const ok = results[di]?.status === 'fulfilled';
          return ok ? { ...s, dirty: false } : s;
        }),
      );
      setTimeout(() => setStatus(''), 1500);
    } finally {
      setBusy(false);
    }
  }

  function discardChanges() {
    if (busy) return;
    void loadAll();
  }

  const selectedBrandLabel = selectedBrandId
    ? brandOptions.find((o) => o.id === selectedBrandId)?.label ?? selectedBrandId
    : null;

  if (!props.canView) {
    return <div style={{ padding: 16, color: 'var(--subtle)' }}>Недостаточно прав для просмотра услуг.</div>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minHeight: 0, height: '100%' }}>
      <div style={{ display: 'grid', gap: 8, gridTemplateColumns: 'minmax(280px, 360px) minmax(220px, 1fr) auto auto auto', alignItems: 'center' }}>
        <label style={{ display: 'grid', gap: 4 }}>
          <span style={{ fontSize: 12, color: 'var(--subtle)' }}>Марка двигателя</span>
          <SearchSelect
            value={selectedBrandId}
            options={brandOptions}
            placeholder="Выберите марку"
            disabled={brandOptions.length === 0}
            showAllWhenEmpty
            onChange={(next) => setSelectedBrandId(next)}
          />
        </label>
        <label style={{ display: 'grid', gap: 4 }}>
          <span style={{ fontSize: 12, color: 'var(--subtle)' }}>Поиск услуги</span>
          <Input value={query} placeholder="Название…" onChange={(e) => setQuery(e.target.value)} />
        </label>
        <label style={{ display: 'grid', gap: 4 }}>
          <span style={{ fontSize: 12, color: 'var(--subtle)' }}>Фильтр</span>
          <select
            value={filterMode}
            onChange={(e) => setFilterMode(e.target.value as FilterMode)}
            disabled={!selectedBrandId}
            style={{ height: 32, padding: '4px 8px', background: 'var(--input-bg)', color: 'var(--text)', border: '1px solid var(--input-border)' }}
          >
            <option value="all">Все услуги</option>
            <option value="bound">Только применимые к этой марке</option>
            <option value="universal">Универсальные (без марок)</option>
            <option value="other">Применимые к другим маркам</option>
          </select>
        </label>
        {props.canEdit ? (
          <Button variant="ghost" disabled={!selectedBrandId || filteredServices.length === 0} onClick={() => bulkToggle('attach')}>
            Привязать всех в списке
          </Button>
        ) : null}
        {props.canEdit ? (
          <Button variant="ghost" disabled={!selectedBrandId || filteredServices.length === 0} onClick={() => bulkToggle('detach')}>
            Отвязать всех в списке
          </Button>
        ) : null}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12, color: 'var(--subtle)' }}>
        <span>
          {selectedBrandLabel ? `Марка: «${selectedBrandLabel}» · ` : ''}
          Услуг в списке: {filteredServices.length}{services.length > filteredServices.length ? ` из ${services.length}` : ''}
        </span>
        <span style={{ flex: 1 }} />
        {dirtyCount > 0 ? (
          <>
            <span style={{ color: 'var(--warning, #b45309)' }}>Несохранённых изменений: {dirtyCount}</span>
            {props.canEdit ? (
              <Button variant="primary" disabled={busy} onClick={() => void saveChanges()}>
                Сохранить ({dirtyCount})
              </Button>
            ) : null}
            <Button variant="ghost" disabled={busy} onClick={() => discardChanges()}>
              Отменить
            </Button>
          </>
        ) : null}
        {status ? <span>{status}</span> : null}
      </div>

      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', border: '1px solid var(--border)' }}>
        {loading ? (
          <div style={{ padding: 12, color: 'var(--subtle)' }}>Загрузка…</div>
        ) : (
          <table className="list-table">
            <thead>
              <tr>
                <th data-col-kind="flag" title="✓" style={{ width: 36, textAlign: 'center' }}>✓</th>
                <th data-col-kind="name" style={{ textAlign: 'left' }}>Услуга</th>
                <th style={{ textAlign: 'left' }}>Ед.</th>
                <th data-col-kind="num" title="Цена" style={{ textAlign: 'right' }}>Цена</th>
                <th data-col-kind="text" style={{ textAlign: 'left' }}>Применимо к маркам</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {filteredServices.length === 0 ? (
                <tr>
                  <td colSpan={6} style={{ textAlign: 'center', color: 'var(--subtle)', padding: 12 }}>
                    Нет услуг под фильтр
                  </td>
                </tr>
              ) : (
                filteredServices.map((s) => {
                  const isBound = selectedBrandId ? s.engineBrandIds.includes(selectedBrandId) : false;
                  const isUniversal = s.engineBrandIds.length === 0;
                  const brandNames = s.engineBrandIds
                    .map((id) => brandOptions.find((o) => o.id === id)?.label ?? id)
                    .sort((a, b) => a.localeCompare(b, 'ru'));
                  return (
                    <tr key={s.id} style={s.dirty ? { background: 'rgba(245, 158, 11, 0.08)' } : undefined}>
                      <td data-col-kind="flag" style={{ textAlign: 'center' }}>
                        <input
                          type="checkbox"
                          checked={isBound}
                          disabled={!selectedBrandId || !props.canEdit}
                          onChange={() => toggleService(s.id)}
                        />
                      </td>
                      <td data-col-kind="name" style={{ verticalAlign: 'top' }}>{s.name}</td>
                      <td style={{ verticalAlign: 'top' }}>{s.unit || '—'}</td>
                      <td data-col-kind="num" style={{ textAlign: 'right', verticalAlign: 'top' }}>
                        {s.price != null ? s.price.toLocaleString('ru-RU') : '—'}
                      </td>
                      <td data-col-kind="text" style={{ verticalAlign: 'top', fontSize: 12 }}>
                        {isUniversal ? (
                          <span style={{ color: 'var(--subtle)' }}>универсальная</span>
                        ) : (
                          brandNames.join(', ')
                        )}
                      </td>
                      <td style={{ verticalAlign: 'top' }}>
                        <Button variant="outline" tone="neutral" size="sm" onClick={() => props.onOpenService(s.id)}>
                          Открыть
                        </Button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
