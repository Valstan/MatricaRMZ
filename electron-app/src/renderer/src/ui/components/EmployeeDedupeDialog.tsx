import React, { useCallback, useEffect, useState } from 'react';

import {
  employeeRoleLabelRu,
  type EmployeeDupGroup,
  type EmployeeGroupMergeReport,
} from '@matricarmz/shared';

import { Button } from './Button.js';

/**
 * Поиск и слияние дублей сотрудников (просьба владельца 08.09.2026: один человек завёлся
 * дважды — автоматический аккаунт и созданный им самим).
 *
 * Порядок намеренно в два шага: сперва **проверка** (dry-run) показывает, что именно произойдёт,
 * и только потом слияние. Операция необратима и трогает права человека.
 *
 * Слияние — ГРУППОЙ (просьба владельца 07.11.2026): прежде сливалась только пара, и группа
 * из трёх записей («Хапикова И. С.» на проде) не сливалась вовсе — диалог прямо отказывал
 * («слияние идёт парами»). Теперь:
 *   · галочками оператор отмечает, КАКИЕ записи сливать (остальные останутся как есть);
 *   · радио выбирает основную запись — ту, чей логин, пароль, роль и доступ останутся
 *     нетронутыми, а к которой переедут остальные;
 *   · слить можно хоть три, хоть четыре записи разом.
 */
export function EmployeeDedupeDialog(props: { onClose: () => void; onMerged: () => void }) {
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState('');
  const [groups, setGroups] = useState<EmployeeDupGroup[]>([]);
  const [survivorByGroup, setSurvivorByGroup] = useState<Record<number, string>>({});
  /** Отметки «слить эту запись» по группам: id записи → отмечена ли. */
  const [losersByGroup, setLosersByGroup] = useState<Record<number, Record<string, boolean>>>({});
  const [reportByGroup, setReportByGroup] = useState<Record<number, EmployeeGroupMergeReport>>({});
  const [busyGroup, setBusyGroup] = useState<number | null>(null);

  const analyze = useCallback(async () => {
    setLoading(true);
    setStatus('');
    try {
      const r = await window.matrica.employees.dedupeAnalyze();
      if (!r.ok) {
        setStatus(`Ошибка: ${r.error}`);
        setGroups([]);
        return;
      }
      setGroups(r.groups);
      // Основной по умолчанию — запись с доступом, иначе с бо́льшим числом заполненных полей.
      // Галочки дублей: по умолчанию отмечены ВСЕ остальные записи группы (слияние одним
      // шагом), оператор снимает галочку с той, которую сливать не надо.
      const preset: Record<number, string> = {};
      const losers: Record<number, Record<string, boolean>> = {};
      r.groups.forEach((g, i) => {
        const best = [...g.employees].sort(
          (a, b) =>
            Number(b.accessEnabled === true) - Number(a.accessEnabled === true) ||
            Number(b.hasPassword) - Number(a.hasPassword) ||
            b.filledAttrs - a.filledAttrs ||
            a.createdAt - b.createdAt,
        )[0];
        if (!best) return;
        preset[i] = best.id;
        losers[i] = {};
        for (const e of g.employees) {
          if (e.id !== best.id) losers[i]![e.id] = true;
        }
      });
      setSurvivorByGroup(preset);
      setLosersByGroup(losers);
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void analyze();
  }, [analyze]);

  /** Выбор основной: с неё снимается галочка — основной не сливается никогда. */
  const setSurvivor = (gi: number, id: string) => {
    setSurvivorByGroup((p) => ({ ...p, [gi]: id }));
    setLosersByGroup((p) => ({ ...p, [gi]: { ...(p[gi] ?? {}), [id]: false } }));
  };

  const toggleLoser = (gi: number, id: string) =>
    setLosersByGroup((p) => ({ ...p, [gi]: { ...(p[gi] ?? {}), [id]: !p[gi]?.[id] } }));

  async function runMerge(groupIndex: number, dryRun: boolean) {
    const group = groups[groupIndex];
    const survivorId = survivorByGroup[groupIndex] ?? '';
    if (!group || !survivorId) return;
    const loserIds = group.employees
      .map((e) => e.id)
      .filter((id) => id !== survivorId && losersByGroup[groupIndex]?.[id]);
    if (loserIds.length === 0) {
      setStatus('Отметьте галочками хотя бы одну запись для слияния.');
      return;
    }
    setBusyGroup(groupIndex);
    setStatus('');
    try {
      const r = await window.matrica.employees.dedupeMerge({
        survivorId,
        loserIds,
        ...(dryRun ? { dryRun: true } : {}),
      });
      if (!r.ok) {
        setStatus(`Ошибка: ${r.error}`);
        return;
      }
      setReportByGroup((prev) => ({ ...prev, [groupIndex]: r.report }));
      if (!dryRun) {
        if (r.report.failed) {
          setStatus(
            `Слияние остановлено на записи ${r.report.failed.loserId.slice(0, 8)}: ${r.report.failed.error}. ` +
              'Уже слитые стоят на основной — повтор продолжит с того же места.',
          );
        }
        props.onMerged();
        await analyze();
      }
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    } finally {
      setBusyGroup(null);
    }
  }

  return (
    <div
      data-employee-dedupe
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(15, 23, 42, 0.6)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1200,
        padding: 20,
      }}
    >
      <div style={{ width: 'min(900px, 96vw)', maxHeight: '90vh', overflow: 'auto', background: 'var(--surface)', borderRadius: 14, padding: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ fontWeight: 800, fontSize: 16 }}>Дубли сотрудников</div>
          <div style={{ flex: 1 }} />
          <Button variant="ghost" onClick={() => void analyze()} disabled={loading}>
            Обновить
          </Button>
          <Button variant="ghost" onClick={props.onClose}>
            Закрыть
          </Button>
        </div>

        <div style={{ marginTop: 8, color: 'var(--muted)' }}>
          Отметьте галочками записи, которые нужно слить (можно сразу все — хоть три, хоть четыре), и
          выберите радио основную: её логин, пароль, роль и доступ останутся нетронутыми, а из
          отмеченных перенесутся только те поля, которых у основной нет, а также чат, файлы, заметки и
          права. Сначала нажмите «Проверить» — он покажет, что произойдёт, ничего не меняя.
        </div>

        {status ? <div style={{ marginTop: 8, color: 'var(--danger)' }}>{status}</div> : null}
        {loading ? <div style={{ marginTop: 12 }}>Ищу дубли…</div> : null}
        {!loading && groups.length === 0 && !status ? <div style={{ marginTop: 12 }}>Дублей не найдено.</div> : null}

        {groups.map((group, i) => {
          const report = reportByGroup[i];
          const survivorId = survivorByGroup[i] ?? '';
          const loserIds = group.employees
            .map((e) => e.id)
            .filter((id) => id !== survivorId && losersByGroup[i]?.[id]);
          return (
            <div key={`${group.key}:${i}`} data-dedupe-group style={{ marginTop: 14, padding: 10, border: '1px solid var(--border)', borderRadius: 10 }}>
              <div style={{ fontWeight: 700 }}>
                {group.employees[0]?.fullName || group.key}
                <span className="ui-muted">
                  {' '}
                  · {group.kind === 'exact' ? 'имена совпадают' : 'имена похожи'} · записей: {group.employees.length}
                </span>
              </div>
              <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 8 }}>
                <thead>
                  <tr>
                    {['Слить', 'Основная', 'ФИО', 'Логин', 'Табельный', 'Роль', 'Доступ', 'Пароль', 'Заполнено полей'].map((h) => (
                      <th key={h} style={{ textAlign: 'left', padding: '4px 6px', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' }}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {group.employees.map((emp) => (
                    <tr key={emp.id} data-dedupe-row={emp.id}>
                      <td style={{ padding: '4px 6px' }}>
                        <input
                          type="checkbox"
                          data-dedupe-merge-check
                          checked={emp.id !== survivorId && losersByGroup[i]?.[emp.id] === true}
                          disabled={emp.id === survivorId}
                          onChange={() => toggleLoser(i, emp.id)}
                        />
                      </td>
                      <td style={{ padding: '4px 6px' }}>
                        <input
                          type="radio"
                          name={`survivor-${i}`}
                          checked={survivorId === emp.id}
                          onChange={() => setSurvivor(i, emp.id)}
                        />
                      </td>
                      <td style={{ padding: '4px 6px' }}>{emp.fullName}</td>
                      <td style={{ padding: '4px 6px' }}>{emp.login ?? '—'}</td>
                      <td style={{ padding: '4px 6px' }}>{emp.personnelNumber ?? '—'}</td>
                      <td style={{ padding: '4px 6px' }}>{emp.systemRole ? employeeRoleLabelRu(emp.systemRole) : '—'}</td>
                      <td style={{ padding: '4px 6px' }}>{emp.accessEnabled === true ? 'разрешён' : emp.accessEnabled === false ? 'запрещён' : '—'}</td>
                      <td style={{ padding: '4px 6px' }}>{emp.hasPassword ? 'задан' : 'нет'}</td>
                      <td style={{ padding: '4px 6px' }}>{emp.filledAttrs}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {report ? (
                <div data-dedupe-report style={{ marginTop: 8, color: report.dryRun ? 'var(--muted)' : 'var(--success, #16a34a)' }}>
                  {report.dryRun ? 'Проверка: ' : 'Объединено: '}
                  слито записей {report.merged.length}; полей будет заполнено {report.totals.attrsFilled}; настроек клиента
                  перевешено {report.totals.clientSettingsRelinked}; ссылок{' '}
                  {report.dryRun ? 'будет переведено' : 'переведено'} {report.totals.referencesMoved}
                  {report.failed ? `; остановлено на записи ${report.failed.loserId.slice(0, 8)}: ${report.failed.error}` : ''}
                </div>
              ) : null}

              <div style={{ marginTop: 10, display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <Button variant="ghost" data-dedupe-dry disabled={busyGroup === i || !survivorId || loserIds.length === 0} onClick={() => void runMerge(i, true)}>
                  Проверить
                </Button>
                <Button
                  tone="success"
                  data-dedupe-merge
                  disabled={busyGroup === i || !survivorId || !report || loserIds.length === 0}
                  title={report ? 'Объединить отмеченные записи' : 'Сначала нажмите «Проверить»'}
                  onClick={() => void runMerge(i, false)}
                >
                  Объединить
                </Button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
