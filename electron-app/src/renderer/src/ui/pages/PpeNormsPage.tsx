import React, { useCallback, useEffect, useMemo, useState } from 'react';

import { Button } from '../components/Button.js';
import { useConfirm } from '../components/ConfirmContext.js';
import { FormField } from '../components/FormField.js';
import { FormGrid } from '../components/FormGrid.js';
import { Input } from '../components/Input.js';
import { ListCount } from '../components/ListCount.js';
import { RowNumberCell, RowNumberHeaderCell } from '../components/RowNumberCell.js';
import { SearchSelect, type SearchSelectOption } from '../components/SearchSelect.js';
import { SectionCard } from '../components/SectionCard.js';

type NormRow = {
  id: string;
  name: string;
  postTitle: string | null;
  validFrom: number;
  validTo: number | null;
  linesCount: number;
};

type NormLine = { id: string; nomenclatureId: string; qty: number; wearMonths: number };
type LineDraft = { nomenclatureId: string | null; qty: string; wearMonths: string };

const ROWNUM_STYLE: React.CSSProperties = { width: '1%', whiteSpace: 'nowrap', textAlign: 'right', color: '#6b7280' };

function fmtDate(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return '—';
  const d = new Date(ms);
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
}

function toInputDate(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return '';
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function fromInputDate(v: string): number | null {
  if (!v) return null;
  const [y, m, d] = v.split('-').map((x) => Number(x));
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
}

const EMPTY_LINE: LineDraft = { nomenclatureId: null, qty: '1', wearMonths: '12' };

/**
 * Нормы выдачи СИЗ. Набор = должность + строки (номенклатура-размер, кол-во, срок
 * носки в месяцах). Размер — отдельная позиция номенклатуры: в строке выбирается
 * именно размер («Куртка зимняя, р.52»), а не базовая модель. Данные живут на
 * сервере (REST /ppe), без связи страница пуста — как приказы о ценах.
 */
export function PpeNormsPage(props: { canEdit: boolean }) {
  const [rows, setRows] = useState<NormRow[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [postTitle, setPostTitle] = useState('');
  const [validFrom, setValidFrom] = useState(toInputDate(Date.now()));
  const [isNew, setIsNew] = useState(false);
  const [lines, setLines] = useState<NormLine[]>([]);
  const [lineDraft, setLineDraft] = useState<LineDraft>(EMPTY_LINE);
  const [nomenclature, setNomenclature] = useState<SearchSelectOption[]>([]);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState('');

  const { confirm } = useConfirm();
  const canEdit = props.canEdit;

  const refresh = useCallback(async () => {
    const res = await window.matrica.ppe.norms.list();
    if (!res.ok) {
      setStatus(`Ошибка: ${res.error}`);
      return;
    }
    setRows(res.rows);
  }, []);

  const refreshLines = useCallback(async (id: string | null) => {
    if (!id) {
      setLines([]);
      return;
    }
    const res = await window.matrica.ppe.norms.get(id);
    if (!res.ok) {
      setStatus(`Ошибка: ${res.error}`);
      return;
    }
    setLines(res.normSet.lines);
  }, []);

  useEffect(() => {
    void (async () => {
      setStatus('Загрузка...');
      await refresh();
      setStatus('');
    })();
  }, [refresh]);

  useEffect(() => {
    void (async () => {
      const res = await window.matrica.warehouse.nomenclatureList({ limit: 2000, offset: 0 }).catch(() => null);
      if (res?.ok) {
        setNomenclature(
          (res.rows ?? []).map((r: any) => ({
            id: String(r.id),
            label: String(r.name ?? ''),
            ...(r.code ? { hintText: String(r.code) } : {}),
            searchText: `${r.name ?? ''} ${r.code ?? ''}`,
          })),
        );
      }
    })();
  }, []);

  const nomName = useCallback(
    (id: string) => nomenclature.find((n) => n.id === id)?.label ?? id,
    [nomenclature],
  );

  const selected = useMemo(() => rows.find((r) => r.id === selectedId) ?? null, [rows, selectedId]);

  function select(row: NormRow) {
    setSelectedId(row.id);
    setIsNew(false);
    setName(row.name);
    setPostTitle(row.postTitle ?? '');
    setValidFrom(toInputDate(row.validFrom));
    setLineDraft(EMPTY_LINE);
    void refreshLines(row.id);
  }

  function startNew() {
    setSelectedId(null);
    setIsNew(true);
    setName('');
    setPostTitle('');
    setValidFrom(toInputDate(Date.now()));
    setLines([]);
    setLineDraft(EMPTY_LINE);
  }

  async function save() {
    if (!name.trim()) return setStatus('Укажите название набора');
    const vf = fromInputDate(validFrom);
    if (vf == null) return setStatus('Укажите дату начала действия');
    setBusy(true);
    try {
      // Строки правятся поштучно (кнопки ниже) и уже лежат на сервере; сохранение
      // шапки везёт их текущим составом — удаление строк молча не теряет: upsert
      // заменяет строки, и подтверждение спрашивается в removeLine.
      const res = await window.matrica.ppe.norms.upsert({
        ...(selectedId ? { id: selectedId } : {}),
        name: name.trim(),
        ...(postTitle.trim() ? { postTitle: postTitle.trim() } : { postTitle: null }),
        validFrom: vf,
        lines: lines.map((l) => ({ nomenclatureId: l.nomenclatureId, qty: l.qty, wearMonths: l.wearMonths })),
      });
      if (!res.ok) {
        setStatus(`Ошибка: ${res.error}`);
        return;
      }
      await refresh();
      setSelectedId(res.id);
      setIsNew(false);
      setStatus('Набор норм сохранён');
      void refreshLines(res.id);
    } finally {
      setBusy(false);
    }
  }

  async function addLine() {
    if (!selectedId || isNew) return setStatus('Сначала сохраните набор, затем добавляйте строки');
    const qty = Math.trunc(Number(String(lineDraft.qty).replace(',', '.')));
    const wear = Math.trunc(Number(String(lineDraft.wearMonths).replace(',', '.')));
    if (!lineDraft.nomenclatureId) return setStatus('Выберите номенклатуру (размер)');
    if (!Number.isInteger(qty) || qty <= 0) return setStatus('Количество — целое больше нуля');
    if (!Number.isInteger(wear) || wear <= 0) return setStatus('Срок носки — целые месяцы больше нуля');
    if (lines.some((l) => l.nomenclatureId === lineDraft.nomenclatureId)) return setStatus('Эта позиция уже есть в наборе');
    setBusy(true);
    try {
      const next = [...lines.map((l) => ({ nomenclatureId: l.nomenclatureId, qty: l.qty, wearMonths: l.wearMonths })), {
        nomenclatureId: lineDraft.nomenclatureId,
        qty,
        wearMonths: wear,
      }];
      const res = await window.matrica.ppe.norms.upsert({
        id: selectedId,
        name: name.trim() || (selected?.name ?? 'Набор'),
        ...(postTitle.trim() ? { postTitle: postTitle.trim() } : { postTitle: null }),
        validFrom: fromInputDate(validFrom) ?? Date.now(),
        lines: next,
      });
      if (!res.ok) {
        setStatus(`Ошибка: ${res.error}`);
        return;
      }
      setLineDraft(EMPTY_LINE);
      await refresh();
      void refreshLines(selectedId);
      setStatus('Строка добавлена');
    } finally {
      setBusy(false);
    }
  }

  async function removeLine(line: NormLine) {
    if (!selectedId) return;
    const ok = await confirm({
      title: 'Убрать позицию из нормы?',
      detail: `${nomName(line.nomenclatureId)}: ${line.qty} шт, носка ${line.wearMonths} мес. Прошлые выдачи по ней останутся в карточках.`,
      confirmLabel: 'Убрать',
    });
    if (!ok) return;
    setBusy(true);
    try {
      const next = lines.filter((l) => l.id !== line.id).map((l) => ({ nomenclatureId: l.nomenclatureId, qty: l.qty, wearMonths: l.wearMonths }));
      const res = await window.matrica.ppe.norms.upsert({
        id: selectedId,
        name: name.trim() || (selected?.name ?? 'Набор'),
        ...(postTitle.trim() ? { postTitle: postTitle.trim() } : { postTitle: null }),
        validFrom: fromInputDate(validFrom) ?? Date.now(),
        lines: next,
      });
      if (!res.ok) {
        setStatus(`Ошибка: ${res.error}`);
        return;
      }
      await refresh();
      void refreshLines(selectedId);
      setStatus('Строка убрана');
    } finally {
      setBusy(false);
    }
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => `${r.name} ${r.postTitle ?? ''}`.toLowerCase().includes(q));
  }, [rows, query]);

  const canEditLines = canEdit && !!selectedId && !isNew;

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(280px, 380px) 1fr', gap: 16, alignItems: 'start' }}>
      <SectionCard title="Наборы норм">
        <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Поиск по названию" style={{ flex: 1 }} />
          {canEdit ? (
            <Button variant="primary" onClick={startNew} disabled={busy}>
              + Набор
            </Button>
          ) : null}
        </div>
        {filtered.length === 0 ? (
          <div style={{ color: 'var(--muted)' }}>{rows.length === 0 ? 'Наборов пока нет.' : 'Ничего не найдено.'}</div>
        ) : (
          <>
            <ListCount total={rows.length} shown={filtered.length} />
            <table className="table" style={{ width: '100%' }}>
              <thead>
                <tr>
                  <RowNumberHeaderCell style={ROWNUM_STYLE} />
                  <th>Набор</th>
                  <th style={{ textAlign: 'right' }}>Позиций</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((r, i) => (
                  <tr
                    key={r.id}
                    onClick={() => select(r)}
                    style={{ cursor: 'pointer', background: r.id === selectedId ? 'var(--accent-soft, rgba(0,0,0,0.06))' : undefined }}
                  >
                    <RowNumberCell n={i + 1} style={ROWNUM_STYLE} />
                    <td>
                      <div>{r.name}</div>
                      <div style={{ color: 'var(--muted)', fontSize: 12 }}>
                        {[r.postTitle, `с ${fmtDate(r.validFrom)}`].filter(Boolean).join(' · ')}
                      </div>
                    </td>
                    <td style={{ textAlign: 'right' }}>{r.linesCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </SectionCard>

      <div style={{ display: 'grid', gap: 16 }}>
        {!selectedId && !isNew ? (
          <SectionCard title="Нормы выдачи">
            <div style={{ color: 'var(--muted)' }}>
              Выберите набор слева{canEdit ? ' или создайте новый' : ''}. Набор привязывается к должности; сотрудник получает один или несколько
              наборов в личной карточке СИЗ.
            </div>
          </SectionCard>
        ) : (
          <SectionCard title={isNew ? 'Новый набор' : `Набор «${selected?.name ?? ''}»`}>
            <FormGrid>
              <FormField label="Название">
                <Input value={name} disabled={!canEdit} onChange={(e) => setName(e.target.value)} placeholder="Слесарь РМЦ, основная" />
              </FormField>
              <FormField label="Должность">
                <Input value={postTitle} disabled={!canEdit} onChange={(e) => setPostTitle(e.target.value)} placeholder="Слесарь" />
              </FormField>
              <FormField label="Действует с">
                <Input type="date" value={validFrom} disabled={!canEdit} onChange={(e) => setValidFrom(e.target.value)} />
              </FormField>
            </FormGrid>
            {canEdit ? (
              <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                <Button variant="primary" onClick={() => void save()} disabled={busy}>
                  Сохранить набор
                </Button>
              </div>
            ) : null}
          </SectionCard>
        )}

        {selectedId && !isNew ? (
          <SectionCard title="Позиции набора">
            {canEditLines ? (
              <div style={{ display: 'grid', gridTemplateColumns: 'minmax(220px, 2fr) 110px 130px auto', gap: 8, alignItems: 'end', marginBottom: 12 }}>
                <FormField label="Номенклатура (размер)">
                  <SearchSelect value={lineDraft.nomenclatureId} options={nomenclature} placeholder="Выберите позицию" showAllWhenEmpty onChange={(next) => setLineDraft({ ...lineDraft, nomenclatureId: next })} />
                </FormField>
                <FormField label="Кол-во">
                  <Input value={lineDraft.qty} onChange={(e) => setLineDraft({ ...lineDraft, qty: e.target.value })} inputMode="numeric" placeholder="1" />
                </FormField>
                <FormField label="Носка, мес">
                  <Input value={lineDraft.wearMonths} onChange={(e) => setLineDraft({ ...lineDraft, wearMonths: e.target.value })} inputMode="numeric" placeholder="12" />
                </FormField>
                <Button variant="primary" onClick={() => void addLine()} disabled={busy}>
                  Добавить
                </Button>
              </div>
            ) : null}
            {lines.length === 0 ? (
              <div style={{ color: 'var(--muted)' }}>В наборе пока нет позиций.</div>
            ) : (
              <>
                <ListCount total={lines.length} shown={lines.length} />
                <table className="table" style={{ width: '100%' }}>
                  <thead>
                    <tr>
                      <RowNumberHeaderCell style={ROWNUM_STYLE} />
                      <th>Позиция</th>
                      <th style={{ textAlign: 'right' }}>Кол-во</th>
                      <th style={{ textAlign: 'right' }}>Носка, мес</th>
                      {canEditLines ? <th /> : null}
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((l, i) => (
                      <tr key={l.id}>
                        <RowNumberCell n={i + 1} style={ROWNUM_STYLE} />
                        <td>{nomName(l.nomenclatureId)}</td>
                        <td style={{ textAlign: 'right' }}>{l.qty}</td>
                        <td style={{ textAlign: 'right' }}>{l.wearMonths}</td>
                        {canEditLines ? (
                          <td style={{ textAlign: 'right' }}>
                            <Button variant="ghost" onClick={() => void removeLine(l)} disabled={busy}>
                              Убрать
                            </Button>
                          </td>
                        ) : null}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </SectionCard>
        ) : null}

        {status ? <div style={{ color: status.startsWith('Ошибка') ? 'var(--danger, #b00)' : 'var(--muted)' }}>{status}</div> : null}
      </div>
    </div>
  );
}
