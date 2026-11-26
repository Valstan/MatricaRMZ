import React from 'react';

import {
  WORK_ORDER_DATE_MODE_LABELS,
  withWorkOrderCommonPeriod,
  withWorkOrderEmployeePeriod,
  type WorkOrderCrewMember,
  type WorkOrderDateMode,
  type WorkOrderPeriod,
} from '@matricarmz/shared';

import { Input } from './Input.js';

/**
 * Редактор дат выполнения работ наряда (промт КАРМАНА #165).
 *
 * Два режима, как их описал владелец:
 *  - **Период** — оператор вносит период («с 13 мая по 2 июня»), и в наряд попадают
 *    все виды работ сотрудника; у отдельных работ дат нет, у всех одна общая дата;
 *  - **Ежедневно** — у каждой работы своя дата (заполняется в таблице «Виды работ»).
 *
 * Период бывает свой у каждого сотрудника бригады (один работает по дням, другой
 * закрывает наряд за период) — поэтому здесь есть и общий период наряда, и периоды
 * по сотрудникам.
 *
 * Дата выполнения НАРЯДА (`completedDate`) здесь не участвует: это другая величина,
 * её по-прежнему ставит оператор в шапке карточки.
 */

function toInputDate(ms: number | null | undefined): string {
  if (!ms) return '';
  const d = new Date(ms);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function fromInputDate(value: string): number | null {
  if (!value) return null;
  const [y, m, d] = value.split('-').map((x) => Number(x));
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d, 12, 0, 0, 0).getTime();
}

type Props = {
  /** Текущий режим дат; null — режим не выбран (старый наряд). */
  mode: WorkOrderDateMode | null;
  /** Периоды наряда (общий и/или по сотрудникам). */
  periods: WorkOrderPeriod[];
  /** Бригада наряда — по ней строятся периоды по сотрудникам. */
  crew: WorkOrderCrewMember[];
  /** Можно ли редактировать (наряд закрыт — нельзя). */
  canEdit: boolean;
  /** Сохранить изменения режима и периодов. */
  onChange: (patch: { workDateMode?: WorkOrderDateMode | undefined; workPeriods?: WorkOrderPeriod[] | undefined }) => void;
};

export function WorkOrderDatesEditor(props: Props) {
  const { mode, periods, crew, canEdit } = props;

  const common = periods.find((p) => !p.employeeId) ?? null;
  const periodOf = (employeeId: string): WorkOrderPeriod | null =>
    periods.find((p) => p.employeeId === employeeId) ?? null;

  const setMode = (next: WorkOrderDateMode) => {
    if (next === mode) return;
    // Переключение режима не стирает введённое: периоды и даты работ остаются,
    // но печатается то, что выбрано. Пустые значения убираем — мусор не храним.
    props.onChange({ workDateMode: next });
  };

  const setCommonPeriod = (from: number | null, to: number | null) => {
    props.onChange({ workPeriods: withWorkOrderCommonPeriod(periods, from, to) });
  };

  const setEmployeePeriod = (employeeId: string, from: number | null, to: number | null) => {
    const next = withWorkOrderEmployeePeriod(periods, employeeId, from, to);
    props.onChange({ workPeriods: next.length ? next : undefined });
  };

  const modeButton = (key: WorkOrderDateMode) => (
    <button
      key={key}
      type="button"
      disabled={!canEdit}
      onClick={() => setMode(key)}
      title={
        key === 'period'
          ? 'Общий период работ: в наряде печатается «с … по …», у отдельных работ дат нет'
          : 'У каждой работы своя дата — заполняется в таблице «Виды работ»'
      }
      style={{
        flex: 1,
        minWidth: 0,
        padding: '6px 8px',
        border: 'none',
        borderLeft: key === 'period' ? 'none' : '1px solid var(--input-border)',
        background: mode === key ? 'var(--button-primary-bg)' : 'var(--input-bg)',
        color: mode === key ? 'var(--button-primary-text)' : 'var(--text)',
        cursor: canEdit ? 'pointer' : 'default',
        fontSize: 12,
        fontWeight: mode === key ? 700 : 400,
        lineHeight: 1.25,
      }}
    >
      {WORK_ORDER_DATE_MODE_LABELS[key]}
    </button>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 240 }}>
      <div style={{ fontSize: 12, color: 'var(--subtle)' }}>Даты выполнения работ</div>
      <div style={{ display: 'flex', border: '1px solid var(--input-border)', borderRadius: 8, overflow: 'hidden' }}>
        {modeButton('period')}
        {modeButton('daily')}
      </div>

      {mode === 'period' ? (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 12, color: 'var(--subtle)' }}>Период работ наряда:</span>
            <span style={{ fontSize: 12 }}>с</span>
            <Input
              type="date"
              value={toInputDate(common?.from)}
              disabled={!canEdit}
              style={{ width: 140 }}
              onChange={(e) => setCommonPeriod(fromInputDate(e.target.value), common?.to ?? null)}
            />
            <span style={{ fontSize: 12 }}>по</span>
            <Input
              type="date"
              value={toInputDate(common?.to)}
              disabled={!canEdit}
              style={{ width: 140 }}
              onChange={(e) => setCommonPeriod(common?.from ?? null, fromInputDate(e.target.value))}
            />
          </div>
          {crew.length > 1 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <div style={{ fontSize: 11, color: 'var(--subtle)' }}>
                Свой период сотрудника — если один работает по дням, а другой закрывает наряд за период. Пусто — общий период наряда.
              </div>
              {crew.map((member) => {
                const own = periodOf(String(member.employeeId ?? ''));
                const label = String(member.employeeName ?? '').trim() || 'Сотрудник';
                return (
                  <div key={String(member.employeeId ?? label)} style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 12, minWidth: 150, maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>
                    <span style={{ fontSize: 12 }}>с</span>
                    <Input
                      type="date"
                      value={toInputDate(own?.from)}
                      disabled={!canEdit}
                      style={{ width: 140 }}
                      onChange={(e) => setEmployeePeriod(String(member.employeeId ?? ''), fromInputDate(e.target.value), own?.to ?? null)}
                    />
                    <span style={{ fontSize: 12 }}>по</span>
                    <Input
                      type="date"
                      value={toInputDate(own?.to)}
                      disabled={!canEdit}
                      style={{ width: 140 }}
                      onChange={(e) => setEmployeePeriod(String(member.employeeId ?? ''), own?.from ?? null, fromInputDate(e.target.value))}
                    />
                  </div>
                );
              })}
            </div>
          ) : null}
        </>
      ) : null}

      {mode === 'daily' ? (
        <div style={{ fontSize: 11, color: 'var(--subtle)' }}>
          У каждой работы своя дата — впишите её в колонку «Дата» таблицы «Виды работ». Если в бригаде несколько
          сотрудников, укажите в колонке «Исполнитель», чья это работа: даты сотрудников не смешиваются.
        </div>
      ) : null}
    </div>
  );
}
