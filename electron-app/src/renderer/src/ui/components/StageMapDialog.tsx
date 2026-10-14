import React, { useState } from 'react';

import type { WorkSheetType } from '@matricarmz/shared';

import { Button } from './Button.js';
import { RepairStageTemplateDialog } from './RepairStageTemplateDialog.js';
import { WorkSheetTypeEditorDialog, type WorkshopOption } from './WorkSheetTypeEditorDialog.js';

/**
 * «Карта этапов» (владелец 14.10.2026) — одна точка входа в оба справочника этапов
 * вместо двух кнопок («Виды работ» + «Шаблон этапов»): это одна карта ремонта, и
 * разводить её по двум сущностям больше не нужно. Сами сущности живут: строки этапов
 * работ ссылаются на виды (код заморожен), единый список — на шаблон.
 *
 * Вкладки: «Этапы ремонта» (шаблон: названия, порядок-приоритет, архив) и
 * «Этапы работ» (виды: цеха, колонки, «завершает ремонт»). Нет одного из прав —
 * вкладки нет, сразу открыт доступный справочник. Монтируется только активная
 * вкладка: редакторы грузят свои данные сами, второй зря не дёргаем.
 */
export function StageMapDialog(props: {
  canManageTypes: boolean;
  canManageStageTemplates: boolean;
  types: WorkSheetType[];
  initialTypeCode: string | null;
  workshops: WorkshopOption[];
  onTypesChanged: () => Promise<void> | void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<'stages' | 'types'>(props.canManageStageTemplates ? 'stages' : 'types');
  const showTabs = props.canManageTypes && props.canManageStageTemplates;
  const active: 'stages' | 'types' =
    tab === 'stages' && !props.canManageStageTemplates ? 'types' : tab === 'types' && !props.canManageTypes ? 'stages' : tab;

  return (
    <div
      role="dialog"
      aria-label="Карта этапов"
      data-stage-map
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}
      onClick={() => props.onClose()}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ background: 'var(--surface)', borderRadius: 10, padding: 16, width: 'min(980px, 96vw)', maxHeight: '90vh', overflow: 'auto', display: 'grid', gap: 12, alignContent: 'start' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ fontWeight: 700, fontSize: 16 }}>Карта этапов</div>
          <div style={{ flex: 1 }} />
          <Button variant="ghost" onClick={props.onClose}>
            Закрыть
          </Button>
        </div>
        {showTabs ? (
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              type="button"
              data-stage-map-tab="stages"
              onClick={() => setTab('stages')}
              style={{
                padding: '4px 12px',
                borderRadius: 999,
                border: '1px solid var(--border)',
                background: active === 'stages' ? 'rgba(37, 99, 235, 0.15)' : 'var(--surface)',
                fontWeight: active === 'stages' ? 700 : 400,
                cursor: 'pointer',
              }}
            >
              Этапы ремонта
            </button>
            <button
              type="button"
              data-stage-map-tab="types"
              onClick={() => setTab('types')}
              style={{
                padding: '4px 12px',
                borderRadius: 999,
                border: '1px solid var(--border)',
                background: active === 'types' ? 'rgba(37, 99, 235, 0.15)' : 'var(--surface)',
                fontWeight: active === 'types' ? 700 : 400,
                cursor: 'pointer',
              }}
            >
              Этапы работ
            </button>
          </div>
        ) : null}
        {active === 'stages' ? (
          <RepairStageTemplateDialog bare onClose={props.onClose} onChanged={props.onTypesChanged} />
        ) : (
          <WorkSheetTypeEditorDialog
            bare
            types={props.types}
            initialTypeCode={props.initialTypeCode}
            workshops={props.workshops}
            onClose={props.onClose}
            onChanged={props.onTypesChanged}
          />
        )}
      </div>
    </div>
  );
}
