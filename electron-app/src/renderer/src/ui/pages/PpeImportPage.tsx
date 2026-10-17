import React, { useMemo, useState } from 'react';

import { Button } from '../components/Button.js';
import { useConfirm } from '../components/ConfirmContext.js';
import { ListCount } from '../components/ListCount.js';
import { RowNumberCell, RowNumberHeaderCell } from '../components/RowNumberCell.js';
import { SectionCard } from '../components/SectionCard.js';

type PreviewRow = {
  line: number;
  sheet: string;
  kind: 'employee' | 'department' | 'absence' | 'issue';
  action: 'create' | 'update' | 'match' | 'exists' | 'conflict';
  ref: string;
  warnings: string[];
  error?: string;
};

type Preview = {
  previewId: string;
  expiresAt: number;
  sheets: { employees: string | null; issues: string | null };
  preview: {
    rows: PreviewRow[];
    summary: {
      employees: { create: number; update: number; match: number; conflict: number };
      departments: { create: number; match: number };
      absences: { create: number; skip: number; conflict: number };
      issues: { create: number; skip: number; conflict: number };
    };
  };
};

type ApplyReport = {
  dryRun: boolean;
  employees: { created: string[]; updated: string[]; matched: number };
  departments: { created: string[]; matched: number };
  absences: { created: number; skipped: number };
  cards: { opened: number };
  entries: { created: number; skipped: number };
};

const ROWNUM_STYLE: React.CSSProperties = { width: '1%', whiteSpace: 'nowrap', textAlign: 'right', color: '#6b7280' };

const KIND_RU: Record<PreviewRow['kind'], string> = {
  employee: 'Сотрудник',
  department: 'Подразделение',
  absence: 'Отпуск',
  issue: 'Выдача',
};

const ACTION_RU: Record<PreviewRow['action'], string> = {
  create: 'создастся',
  update: 'обновится',
  match: 'совпало',
  exists: 'уже есть',
  conflict: 'конфликт',
};

const EXPECTED_EMPLOYEES = 'Табельный номер, ФИО, Должность, Подразделение, Пол, Дата рождения, Дата приёма, Дата увольнения, Отпуск с, Отпуск по';
const EXPECTED_ISSUES = 'Таб. №, Номенклатура/артикул, Размер, Кол-во, Дата';

function fileToBase64(file: File): Promise<string> {
  return file.arrayBuffer().then((buf) => {
    const bytes = new Uint8Array(buf);
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  });
}

/**
 * Импорт СИЗ из выгрузки ЗУП/1С (Excel .xlsx): файл едет base64 на сервер,
 * preview показывает план построчно (создастся/совпало/конфликт), apply — итог.
 * Импорт никогда не создаёт молча: без preview (или с истёкшим preview-id) отказ.
 */
export function PpeImportPage(props: { canEdit: boolean }) {
  const [file, setFile] = useState<{ name: string; size: number; base64: string } | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [report, setReport] = useState<ApplyReport | null>(null);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const canEdit = props.canEdit;

  const { confirm } = useConfirm();

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const picked = e.target.files?.[0];
    e.target.value = '';
    if (!picked) return;
    if (picked.size > 10 * 1024 * 1024) return setStatus('Ошибка: файл больше 10 МБ — сохраните выгрузку компактнее');
    setBusy(true);
    try {
      const base64 = await fileToBase64(picked);
      setFile({ name: picked.name, size: picked.size, base64 });
      setPreview(null);
      setReport(null);
      setStatus('');
    } catch (err) {
      setStatus(`Ошибка чтения файла: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  async function runPreview() {
    if (!file) return;
    setBusy(true);
    try {
      const res = await window.matrica.ppe.import.preview({ filename: file.name, contentBase64: file.base64 });
      if (!res.ok) {
        setStatus(`Ошибка: ${res.error}`);
        setPreview(null);
        return;
      }
      setPreview({
        previewId: res.previewId,
        expiresAt: res.expiresAt,
        sheets: res.sheets,
        preview: res.preview,
      });
      setReport(null);
      setStatus('');
    } finally {
      setBusy(false);
    }
  }

  async function runApply() {
    if (!file || !preview) return;
    const s = preview.preview.summary;
    // Импорт применяется только целиком: сервер перед записью перепроверяет файл и
    // отказывает при любом конфликте (страховка от «данные изменились после проверки»).
    // Сказать это здесь честно — значит не обещать пропуск конфликтных строк, которого
    // нет: оператор исправит файл и проверит его заново.
    const conflictRows = preview.preview.rows.filter((r) => r.action === 'conflict');
    if (conflictRows.length > 0) {
      const lines = conflictRows.slice(0, 10).map((r) => `стр. ${r.line}`).join(', ');
      setStatus(`Ошибка: в файле ${conflictRows.length} конфликтных строк (${lines}) — исправьте файл и проверьте снова; импорт применяется только целиком.`);
      return;
    }
    const ok = await confirm({
      title: 'Применить импорт?',
      detail: `Сотрудники: создать ${s.employees.create}, обновить ${s.employees.update}. Отпуска: +${s.absences.create}. Выдачи: +${s.issues.create}. Файл применяется целиком — если данные успеют измениться между проверкой и применением, откажем и попросим проверить заново.`,
      confirmLabel: 'Применить',
    });
    if (!ok) return;
    setBusy(true);
    try {
      const res = await window.matrica.ppe.import.apply({ previewId: preview.previewId, contentBase64: file.base64 });
      if (!res.ok) {
        setStatus(`Ошибка: ${res.error}`);
        return;
      }
      setReport(res.report);
      setStatus('Импорт применён');
      setPreview(null);
    } finally {
      setBusy(false);
    }
  }

  const problemRows = useMemo(
    () => (preview ? preview.preview.rows.filter((r) => r.action === 'conflict' || r.error) : []),
    [preview],
  );

  return (
    <div style={{ display: 'grid', gap: 16, maxWidth: 1100 }}>
      <SectionCard title="Импорт СИЗ из Excel (ЗУП/1С)">
        <div style={{ color: 'var(--muted)', fontSize: 12, marginBottom: 8 }}>
          Файл выгрузки .xlsx: лист сотрудников ({EXPECTED_EMPLOYEES}) и, если есть, лист выдач ({EXPECTED_ISSUES}). Ничего не пишется, пока не
          нажато «Применить»; проверка действует 30 минут.
        </div>
        {canEdit ? (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <input type="file" accept=".xlsx" onChange={(e) => void onPick(e)} disabled={busy} />
            <Button variant="primary" onClick={() => void runPreview()} disabled={busy || !file}>
              Проверить файл
            </Button>
            {preview ? (
              <Button variant="primary" onClick={() => void runApply()} disabled={busy}>
                Применить
              </Button>
            ) : null}
            {file ? (
              <span style={{ color: 'var(--muted)', fontSize: 12 }}>
                {file.name} · {Math.round(file.size / 1024)} КБ
              </span>
            ) : null}
          </div>
        ) : (
          <div style={{ color: 'var(--muted)' }}>Импорт доступен пользователям с правом правки справочников.</div>
        )}
        {report ? (
          <div style={{ marginTop: 12, fontSize: 13 }}>
            <div>
              Итог: сотрудники — создано {report.employees.created.length}, обновлено {report.employees.updated.length}, совпало{' '}
              {report.employees.matched}; подразделения — создано {report.departments.created.length}; отпуска — +{report.absences.created};
              карточки — открыто {report.cards.opened}; выдачи — +{report.entries.created}, пропущено {report.entries.skipped}.
            </div>
          </div>
        ) : null}
      </SectionCard>

      {preview ? (
        <>
          <SectionCard title="План импорта">
            <div style={{ fontSize: 13, marginBottom: 8 }}>
              Сотрудники: создать {preview.preview.summary.employees.create}, обновить {preview.preview.summary.employees.update}, совпало{' '}
              {preview.preview.summary.employees.match}, конфликтов {preview.preview.summary.employees.conflict}. Подразделения: создать{' '}
              {preview.preview.summary.departments.create}, совпало {preview.preview.summary.departments.match}. Отпуска: +{' '}
              {preview.preview.summary.absences.create}. Выдачи: +{preview.preview.summary.issues.create}, пропуск{' '}
              {preview.preview.summary.issues.skip}, конфликтов {preview.preview.summary.issues.conflict}.
            </div>
            <div style={{ color: 'var(--muted)', fontSize: 12 }}>
              Листы: сотрудники — {preview.sheets.employees ?? 'не найден'}; выдачи — {preview.sheets.issues ?? 'нет'}.
            </div>
          </SectionCard>

          <SectionCard title="Строки проверки">
            {preview.preview.rows.length === 0 ? (
              <div style={{ color: 'var(--muted)' }}>Строк не найдено — проверьте шапку выгрузки.</div>
            ) : (
              <>
                <ListCount total={preview.preview.rows.length} shown={preview.preview.rows.length} />
                <div style={{ maxHeight: 420, overflow: 'auto' }}>
                  <table className="table" style={{ width: '100%' }}>
                    <thead>
                      <tr>
                        <RowNumberHeaderCell style={ROWNUM_STYLE} />
                        <th>Строка</th>
                        <th>Лист</th>
                        <th>Что</th>
                        <th>Действие</th>
                        <th>Запись</th>
                        <th>Примечание</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.preview.rows.map((r, i) => (
                        <tr key={`${r.sheet}-${r.line}-${i}`} style={r.action === 'conflict' || r.error ? { background: 'var(--danger-soft, rgba(200,0,0,0.06))' } : undefined}>
                          <RowNumberCell n={i + 1} style={ROWNUM_STYLE} />
                          <td>{r.line}</td>
                          <td>{r.sheet}</td>
                          <td>{KIND_RU[r.kind]}</td>
                          <td>{ACTION_RU[r.action]}</td>
                          <td>{r.ref}</td>
                          <td>{[r.error, ...r.warnings].filter(Boolean).join('; ')}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </SectionCard>

          {problemRows.length > 0 ? (
            <SectionCard title="Ошибки шапки и конфликты">
              <div style={{ color: 'var(--muted)', fontSize: 12, marginBottom: 8 }}>
                Если не совпадает шапка — проверьте колонки. Ожидаются: сотрудники — {EXPECTED_EMPLOYEES}; выдачи — {EXPECTED_ISSUES}.
              </div>
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>
                {problemRows.slice(0, 100).map((r, i) => (
                  <li key={`${r.sheet}-${r.line}-p-${i}`}>
                    {KIND_RU[r.kind]} · строка {r.line}: {r.error ?? r.warnings.join('; ')}
                  </li>
                ))}
              </ul>
            </SectionCard>
          ) : null}
        </>
      ) : null}

      {status ? <div style={{ color: status.startsWith('Ошибка') ? 'var(--danger, #b00)' : 'var(--muted)' }}>{status}</div> : null}
    </div>
  );
}
