import React, { useCallback, useEffect, useMemo, useState } from 'react';

import { Button } from '../components/Button.js';
import { useConfirm } from '../components/ConfirmContext.js';
import { FormField } from '../components/FormField.js';
import { Input } from '../components/Input.js';
import { ListCount } from '../components/ListCount.js';
import { RowNumberCell, RowNumberHeaderCell } from '../components/RowNumberCell.js';
import { SearchSelect, type SearchSelectOption } from '../components/SearchSelect.js';
import { SectionCard } from '../components/SectionCard.js';

type CollectiveRow = {
  id: string;
  departmentId: string;
  warehouseId: string;
  documentId: string | null;
  distributedAt: number | null;
  linesCount: number;
  employeesCount: number;
};

type DraftLine = { employeeId: string | null; nomenclatureId: string | null; qty: string };

const ROWNUM_STYLE: React.CSSProperties = { width: '1%', whiteSpace: 'nowrap', textAlign: 'right', color: '#6b7280' };
const EMPTY_LINE: DraftLine = { employeeId: null, nomenclatureId: null, qty: '1' };

function fmtDate(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return '—';
  const d = new Date(ms);
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
}

/**
 * Коллективная выдача (PR-3): черновик шапки (подразделение + склад) и строк
 * «сотрудник × позиция × кол-во» → «Провести» создаёт ОДИН документ расхода на
 * подразделение (агрегат по позициям) и персональные следы в карточках.
 * Дежурные СИЗ — тем же путём с флагом: документ на подразделение набора без
 * личных следов; возврат — сторно документа склада.
 */
export function PpeCollectivePage(props: { canEdit: boolean; canIssue: boolean }) {
  const [rows, setRows] = useState<CollectiveRow[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [departmentId, setDepartmentId] = useState<string | null>(null);
  const [warehouseId, setWarehouseId] = useState<string | null>(null);
  const [lines, setLines] = useState<DraftLine[]>([EMPTY_LINE]);
  const [lineDraft, setLineDraft] = useState<DraftLine>(EMPTY_LINE);
  const [selectedInfo, setSelectedInfo] = useState<{ documentId: string | null; distributedAt: number | null } | null>(null);
  const [departments, setDepartments] = useState<SearchSelectOption[]>([]);
  const [warehouses, setWarehouses] = useState<SearchSelectOption[]>([]);
  const [employees, setEmployees] = useState<SearchSelectOption[]>([]);
  const [nomenclature, setNomenclature] = useState<SearchSelectOption[]>([]);
  const [normOptions, setNormOptions] = useState<Array<{ id: string; name: string; isDuty: boolean }>>([]);
  const [dutyNormId, setDutyNormId] = useState<string | null>(null);
  const [dutyWarehouseId, setDutyWarehouseId] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  const { confirm } = useConfirm();
  const canEdit = props.canEdit;

  const refresh = useCallback(async () => {
    const res = await window.matrica.ppe.collectives.list();
    if (!res.ok) {
      setStatus(`Ошибка: ${res.error}`);
      return;
    }
    setRows(res.rows);
  }, []);

  useEffect(() => {
    void (async () => {
      setStatus('Загрузка...');
      await refresh();
      setStatus('');
      const [deps, wh, emp, noms, nrm] = await Promise.all([
        window.matrica.employees.departmentsList().catch(() => []),
        window.matrica.warehouseLocations.list({ activeOnly: true }).catch(() => null),
        window.matrica.ppe.employees.list().catch(() => null),
        window.matrica.warehouse.nomenclatureList({ limit: 2000, offset: 0 }).catch(() => null),
        window.matrica.ppe.norms.list().catch(() => null),
      ]);
      setDepartments(
        (Array.isArray(deps) ? deps : []).map((d: any) => ({ id: String(d.id), label: String(d.displayName ?? d.id) })),
      );
      if (wh?.ok) setWarehouses((wh.rows ?? []).map((w: any) => ({ id: String(w.id), label: String(w.name ?? w.code ?? w.id) })));
      // Пикер — из реплики СИЗ (`erp_employee_cards`): распределение сервер принимает
      // только по этим id (см. ppe:employees:list).
      setEmployees(
        (emp?.ok ? emp.employees : []).map((e) => ({
          id: e.id,
          label: e.fullName.trim() || e.id,
          ...(e.roleCode ? { hintText: e.roleCode } : {}),
          searchText: `${e.fullName} ${e.personnelNo ?? ''} ${e.roleCode ?? ''}`,
        })),
      );
      if (noms?.ok) setNomenclature((noms.rows ?? []).map((r: any) => ({ id: String(r.id), label: String(r.name ?? r.id) })));
      if (nrm?.ok) setNormOptions(nrm.rows.map((r) => ({ id: r.id, name: r.name, isDuty: r.isDuty })));
    })();
  }, [refresh]);

  const deptName = useCallback((id: string) => departments.find((d) => d.id === id)?.label ?? id, [departments]);
  const whName = useCallback((id: string) => warehouses.find((w) => w.id === id)?.label ?? id, [warehouses]);
  const empName = useCallback((id: string) => employees.find((e) => e.id === id)?.label ?? id, [employees]);
  const nomName = useCallback((id: string) => nomenclature.find((n) => n.id === id)?.label ?? id, [nomenclature]);

  async function select(row: CollectiveRow) {
    setIsNew(false);
    setSelectedId(row.id);
    setStatus('');
    const res = await window.matrica.ppe.collectives.get(row.id).catch(() => null);
    if (!res?.ok) {
      setStatus(`Ошибка: ${res?.error ?? 'не удалось открыть'}`);
      return;
    }
    setDepartmentId(res.collective.departmentId);
    setWarehouseId(res.collective.warehouseId);
    setSelectedInfo({ documentId: res.collective.documentId, distributedAt: res.collective.distributedAt });
    setLines(
      res.collective.lines.map((l) => ({ employeeId: l.employeeId, nomenclatureId: l.nomenclatureId, qty: String(l.qty) })),
    );
  }

  function startNew() {
    setIsNew(true);
    setSelectedId(null);
    setSelectedInfo(null);
    setDepartmentId(null);
    setWarehouseId(null);
    setLines([EMPTY_LINE]);
    setLineDraft(EMPTY_LINE);
    setStatus('');
  }

  function addLine() {
    if (!lineDraft.employeeId || !lineDraft.nomenclatureId) return setStatus('Выберите сотрудника и позицию');
    const qty = Math.trunc(Number(String(lineDraft.qty).replace(',', '.')));
    if (!Number.isInteger(qty) || qty <= 0) return setStatus('Количество — целое больше нуля');
    setLines((prev) => [...prev, { ...lineDraft, qty: String(qty) }]);
    setLineDraft(EMPTY_LINE);
    setStatus('');
  }

  async function saveDraft() {
    if (!departmentId) return setStatus('Выберите подразделение');
    if (!warehouseId) return setStatus('Выберите склад выдачи');
    const parsed = lines
      .filter((l) => l.employeeId && l.nomenclatureId)
      .map((l) => ({
        employeeId: String(l.employeeId),
        nomenclatureId: String(l.nomenclatureId),
        qty: Math.trunc(Number(String(l.qty).replace(',', '.'))),
      }));
    if (parsed.length === 0) return setStatus('Добавьте хотя бы одну строку');
    if (parsed.some((l) => !Number.isInteger(l.qty) || l.qty <= 0)) return setStatus('Количество — целое больше нуля');
    setBusy(true);
    try {
      const res = await window.matrica.ppe.collectives.open({
        ...(selectedId ? { id: selectedId } : {}),
        departmentId,
        warehouseId,
        lines: parsed,
      });
      if (!res.ok) {
        setStatus(`Ошибка: ${res.error}`);
        return;
      }
      await refresh();
      setSelectedId(res.id);
      setIsNew(false);
      setSelectedInfo({ documentId: null, distributedAt: null });
      setStatus('Черновик сохранён');
    } finally {
      setBusy(false);
    }
  }

  async function distribute() {
    if (!selectedId) return;
    const employeesCount = new Set(lines.map((l) => l.employeeId).filter(Boolean)).size;
    const ok = await confirm({
      title: 'Провести коллективную выдачу?',
      detail: `${deptName(departmentId ?? '')}: ${lines.length} строк, ${employeesCount} чел. Будет создан и проведён документ расхода на подразделение (агрегат по позициям); выдачи лягут в карточки. Повторный клик не задвоит.`,
      confirmLabel: 'Провести',
    });
    if (!ok) return;
    setBusy(true);
    try {
      const res = await window.matrica.ppe.collectives.distribute({ collectiveId: selectedId });
      if (!res.ok) {
        setStatus(`Ошибка: ${res.error}`);
        return;
      }
      await refresh();
      setSelectedInfo({ documentId: res.documentId, distributedAt: Date.now() });
      setStatus(
        res.alreadyDistributed
          ? `Уже проведена: документ ${res.documentId}`
          : `Проведено: документ ${res.documentId}, строк ${res.entries}, сотрудников ${res.employees}`,
      );
    } finally {
      setBusy(false);
    }
  }

  async function closeDraft() {
    if (!selectedId) return;
    const ok = await confirm({
      title: 'Отменить черновик?',
      detail: 'Черновик коллективной выдачи будет убран. Проведённая выдача так не отменяется — только сторно документа склада.',
      confirmLabel: 'Отменить',
    });
    if (!ok) return;
    setBusy(true);
    try {
      const res = await window.matrica.ppe.collectives.close(selectedId);
      if (!res.ok) {
        setStatus(`Ошибка: ${res.error}`);
        return;
      }
      setSelectedId(null);
      setIsNew(false);
      setSelectedInfo(null);
      await refresh();
      setStatus('Черновик убран');
    } finally {
      setBusy(false);
    }
  }

  async function issueDuty() {
    if (!dutyNormId) return setStatus('Выберите дежурный набор норм');
    if (!dutyWarehouseId) return setStatus('Выберите склад выдачи');
    const norm = normOptions.find((n) => n.id === dutyNormId);
    const ok = await confirm({
      title: 'Выдать дежурные СИЗ?',
      detail: `«${norm?.name ?? ''}»: комплект уйдёт документом расхода на подразделение набора, без личных следов. Возврат — сторно документа склада.`,
      confirmLabel: 'Выдать',
    });
    if (!ok) return;
    setBusy(true);
    try {
      const res = await window.matrica.ppe.duty.issue({ normSetId: dutyNormId, warehouseId: dutyWarehouseId });
      if (!res.ok) {
        setStatus(`Ошибка: ${res.error}`);
        return;
      }
      setStatus(`Дежурные выданы: документ ${res.documentId}. Возврат — сторно этого документа на складе.`);
    } finally {
      setBusy(false);
    }
  }

  const dutyNorms = useMemo(
    () => normOptions.filter((n) => n.isDuty).map((n) => ({ id: n.id, label: n.name })),
    [normOptions],
  );

  const distributed = selectedInfo?.documentId != null && !isNew;
  const editorOpen = isNew || selectedId != null;

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(300px, 420px) 1fr', gap: 16, alignItems: 'start' }}>
      <SectionCard title="Коллективные выдачи">
        {canEdit ? (
          <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
            <Button variant="primary" onClick={startNew} disabled={busy}>
              + Черновик
            </Button>
          </div>
        ) : null}
        {rows.length === 0 ? (
          <div style={{ color: 'var(--muted)' }}>Коллективных выдач пока нет.</div>
        ) : (
          <>
            <ListCount total={rows.length} shown={rows.length} />
            <table className="table" style={{ width: '100%' }}>
              <thead>
                <tr>
                  <RowNumberHeaderCell style={ROWNUM_STYLE} />
                  <th>Выдача</th>
                  <th>Состояние</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr
                    key={r.id}
                    onClick={() => void select(r)}
                    style={{ cursor: 'pointer', background: r.id === selectedId ? 'var(--accent-soft, rgba(0,0,0,0.06))' : undefined }}
                  >
                    <RowNumberCell n={i + 1} style={ROWNUM_STYLE} />
                    <td>
                      <div>{deptName(r.departmentId)}</div>
                      <div style={{ color: 'var(--muted)', fontSize: 12 }}>
                        {whName(r.warehouseId)} · строк {r.linesCount}, людей {r.employeesCount}
                      </div>
                    </td>
                    <td>
                      {r.documentId ? (
                        <span>
                          проведена {fmtDate(r.distributedAt)}
                        </span>
                      ) : (
                        'черновик'
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </SectionCard>

      <div style={{ display: 'grid', gap: 16 }}>
        {!editorOpen ? (
          <SectionCard title="Коллективная выдача">
            <div style={{ color: 'var(--muted)' }}>
              Черновик — это план: подразделение, склад и строки «сотрудник × позиция × количество». «Провести» создаёт один документ расхода на
              подразделение и распределяет выдачи по карточкам.
            </div>
          </SectionCard>
        ) : (
          <SectionCard title={isNew ? 'Новый черновик' : `Выдача: ${deptName(departmentId ?? '')}`}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <FormField label="Подразделение (получатель)">
                <SearchSelect
                  value={departmentId}
                  options={departments}
                  disabled={!canEdit || distributed}
                  placeholder="Подразделение"
                  showAllWhenEmpty
                  onChange={setDepartmentId}
                />
              </FormField>
              <FormField label="Склад выдачи">
                <SearchSelect
                  value={warehouseId}
                  options={warehouses}
                  disabled={!canEdit || distributed}
                  placeholder="Склад"
                  showAllWhenEmpty
                  onChange={setWarehouseId}
                />
              </FormField>
            </div>
            {distributed ? (
              <div style={{ color: 'var(--muted)', fontSize: 12, marginTop: 8 }}>
                Проведена {fmtDate(selectedInfo?.distributedAt ?? null)}, документ {selectedInfo?.documentId}. Отмена проведённой выдачи — сторно
                документа склада (Склад → Документы).
              </div>
            ) : null}
            {lines.length === 0 ? (
              <div style={{ color: 'var(--muted)', marginTop: 8 }}>Строк пока нет.</div>
            ) : (
              <table className="table" style={{ width: '100%', marginTop: 8 }}>
                <thead>
                  <tr>
                    <RowNumberHeaderCell style={ROWNUM_STYLE} />
                    <th>Сотрудник</th>
                    <th>Позиция</th>
                    <th style={{ textAlign: 'right' }}>Кол-во</th>
                    {canEdit && !distributed ? <th /> : null}
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l, i) => (
                    <tr key={i}>
                      <RowNumberCell n={i + 1} style={ROWNUM_STYLE} />
                      <td>{l.employeeId ? empName(l.employeeId) : '—'}</td>
                      <td>{l.nomenclatureId ? nomName(l.nomenclatureId) : '—'}</td>
                      <td style={{ textAlign: 'right' }}>{l.qty}</td>
                      {canEdit && !distributed ? (
                        <td style={{ textAlign: 'right' }}>
                          <Button variant="ghost" onClick={() => setLines((prev) => prev.filter((_, j) => j !== i))} disabled={busy}>
                            Убрать
                          </Button>
                        </td>
                      ) : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {canEdit && !distributed ? (
              <>
                <div style={{ display: 'grid', gridTemplateColumns: 'minmax(200px, 1.4fr) minmax(200px, 1.4fr) 90px auto', gap: 8, alignItems: 'end', marginTop: 12 }}>
                  <FormField label="Сотрудник">
                    <SearchSelect value={lineDraft.employeeId} options={employees} placeholder="Кому" showAllWhenEmpty onChange={(v) => setLineDraft({ ...lineDraft, employeeId: v })} />
                  </FormField>
                  <FormField label="Позиция">
                    <SearchSelect value={lineDraft.nomenclatureId} options={nomenclature} placeholder="Что" showAllWhenEmpty onChange={(v) => setLineDraft({ ...lineDraft, nomenclatureId: v })} />
                  </FormField>
                  <FormField label="Кол-во">
                    <Input value={lineDraft.qty} inputMode="numeric" onChange={(e) => setLineDraft({ ...lineDraft, qty: e.target.value })} />
                  </FormField>
                  <Button variant="ghost" onClick={addLine} disabled={busy}>
                    Добавить
                  </Button>
                </div>
                <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                  <Button variant="primary" onClick={() => void saveDraft()} disabled={busy}>
                    Сохранить черновик
                  </Button>
                  {props.canIssue && selectedId ? (
                    <Button variant="primary" onClick={() => void distribute()} disabled={busy}>
                      Провести
                    </Button>
                  ) : null}
                  {selectedId ? (
                    <Button variant="ghost" tone="danger" onClick={() => void closeDraft()} disabled={busy}>
                      Отмена черновика
                    </Button>
                  ) : null}
                </div>
              </>
            ) : null}
          </SectionCard>
        )}

        <SectionCard title="Дежурные СИЗ">
          <div style={{ color: 'var(--muted)', fontSize: 12, marginBottom: 8 }}>
            Дежурный комплект (норма с пометкой «дежурная») выдаётся документом расхода на подразделение набора — без привязки к людям. Возврат —
            сторно документа склада.
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <FormField label="Дежурная норма">
              <SearchSelect value={dutyNormId} options={dutyNorms} placeholder="Набор (дежурная)" showAllWhenEmpty onChange={setDutyNormId} />
            </FormField>
            <FormField label="Склад выдачи">
              <SearchSelect value={dutyWarehouseId} options={warehouses} placeholder="Склад" showAllWhenEmpty onChange={setDutyWarehouseId} />
            </FormField>
          </div>
          {dutyNorms.length === 0 ? (
            <div style={{ color: 'var(--muted)', fontSize: 12 }}>Дежурных наборов нет — отметьте «дежурная» в редакторе норм.</div>
          ) : null}
          {props.canIssue ? (
            <div style={{ marginTop: 8 }}>
              <Button variant="primary" onClick={() => void issueDuty()} disabled={busy || !dutyNormId || !dutyWarehouseId}>
                Выдать дежурные
              </Button>
            </div>
          ) : null}
        </SectionCard>

        {status ? <div style={{ color: status.startsWith('Ошибка') ? 'var(--danger, #b00)' : 'var(--muted)' }}>{status}</div> : null}
      </div>
    </div>
  );
}
