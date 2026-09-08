import React, { useCallback, useEffect, useState } from 'react';

import type { EmployeeDupGroup, EmployeeMergeReport } from '@matricarmz/shared';

import { Button } from './Button.js';

/**
 * Поиск и слияние дублей сотрудников (просьба владельца 08.09.2026: один человек завёлся
 * дважды — автоматический аккаунт и созданный им самим).
 *
 * Порядок намеренно в два шага: сперва **проверка** (dry-run) показывает, что именно произойдёт,
 * и только потом слияние. Операция необратима и трогает права человека, поэтому оператор
 * выбирает основную запись явно — а не «первую попавшуюся».
 */
export function EmployeeDedupeDialog(props: { onClose: () => void; onMerged: () => void }) {
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState('');
  const [groups, setGroups] = useState<EmployeeDupGroup[]>([]);
  const [survivorByGroup, setSurvivorByGroup] = useState<Record<number, string>>({});
  const [reportByGroup, setReportByGroup] = useState<Record<number, EmployeeMergeReport>>({});
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
      const preset: Record<number, string> = {};
      r.groups.forEach((g, i) => {
        const best = [...g.employees].sort(
          (a, b) =>
            Number(b.accessEnabled === true) - Number(a.accessEnabled === true) ||
            Number(b.hasPassword) - Number(a.hasPassword) ||
            b.filledAttrs - a.filledAttrs ||
            a.createdAt - b.createdAt,
        )[0];
        if (best) preset[i] = best.id;
      });
      setSurvivorByGroup(preset);
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void analyze();
  }, [analyze]);

  async function runMerge(groupIndex: number, dryRun: boolean) {
    const group = groups[groupIndex];
    const survivorId = survivorByGroup[groupIndex] ?? '';
    if (!group || !survivorId) return;
    const losers = group.employees.filter((e) => e.id !== survivorId);
    if (losers.length !== 1) {
      setStatus('Слияние идёт парами: оставьте в группе две записи или объединяйте по одной.');
      return;
    }
    const loser = losers[0]!;
    setBusyGroup(groupIndex);
    setStatus('');
    try {
      const r = await window.matrica.employees.dedupeMerge({ survivorId, loserId: loser.id, ...(dryRun ? { dryRun: true } : {}) });
      if (!r.ok) {
        setStatus(`Ошибка: ${r.error}`);
        return;
      }
      setReportByGroup((prev) => ({ ...prev, [groupIndex]: r.report }));
      if (!dryRun) {
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
          Выберите основную запись — её логин, пароль, роль и доступ останутся нетронутыми. Из второй
          перенесутся только те поля, которых у основной нет, а также чат, файлы, заметки и права.
          Сначала нажмите «Проверить» — он покажет, что произойдёт, ничего не меняя.
        </div>

        {status ? <div style={{ marginTop: 8, color: 'var(--danger)' }}>{status}</div> : null}
        {loading ? <div style={{ marginTop: 12 }}>Ищу дубли…</div> : null}
        {!loading && groups.length === 0 && !status ? <div style={{ marginTop: 12 }}>Дублей не найдено.</div> : null}

        {groups.map((group, i) => {
          const report = reportByGroup[i];
          const survivorId = survivorByGroup[i] ?? '';
          return (
            <div key={`${group.key}:${i}`} data-dedupe-group style={{ marginTop: 14, padding: 10, border: '1px solid var(--border)', borderRadius: 10 }}>
              <div style={{ fontWeight: 700 }}>
                {group.employees[0]?.fullName || group.key}
                <span className="ui-muted"> · {group.kind === 'exact' ? 'имена совпадают' : 'имена похожи'}</span>
              </div>
              <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 8 }}>
                <thead>
                  <tr>
                    {['Основная', 'ФИО', 'Логин', 'Роль', 'Доступ', 'Пароль', 'Заполнено полей'].map((h) => (
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
                          type="radio"
                          name={`survivor-${i}`}
                          checked={survivorId === emp.id}
                          onChange={() => setSurvivorByGroup((prev) => ({ ...prev, [i]: emp.id }))}
                        />
                      </td>
                      <td style={{ padding: '4px 6px' }}>{emp.fullName}</td>
                      <td style={{ padding: '4px 6px' }}>{emp.login ?? '—'}</td>
                      <td style={{ padding: '4px 6px' }}>{emp.systemRole ?? '—'}</td>
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
                  полей будет заполнено {report.attrsFilled}; настроек клиента перевешено {report.clientSettingsRelinked};
                  {report.userReferencesMoved ? ' чат, файлы и права переносятся' : ' переносить пользовательские ссылки не потребуется'}
                  {report.protectedSkipped.length > 0 ? `; не тронуты: ${report.protectedSkipped.join(', ')}` : ''}
                </div>
              ) : null}

              <div style={{ marginTop: 10, display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <Button variant="ghost" data-dedupe-dry disabled={busyGroup === i || !survivorId} onClick={() => void runMerge(i, true)}>
                  Проверить
                </Button>
                <Button
                  tone="success"
                  data-dedupe-merge
                  disabled={busyGroup === i || !survivorId || !report}
                  title={report ? 'Объединить записи' : 'Сначала нажмите «Проверить»'}
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
