import { useEffect, useState } from 'react';

import { DEFAULT_REPAIR_STAGE_TEMPLATES, type RepairStageTemplate } from '@matricarmz/shared';

/**
 * Шаблон единого списка этапов для ступеней «Этап на заводе» и отчётов.
 * Сервер, при отказе — статика (тот же уклад, что у видов работ): ступень живёт
 * на том, что несут сами строки.
 */
export function useRepairStageTemplateRefs(): RepairStageTemplate[] {
  const [templates, setTemplates] = useState<RepairStageTemplate[]>([]);
  useEffect(() => {
    let alive = true;
    void window.matrica.workSheets.stages.templates
      .list()
      .then((res) => {
        if (!alive) return;
        if (res.ok && res.templates.length > 0) setTemplates(res.templates);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  return templates.length > 0 ? templates : [...DEFAULT_REPAIR_STAGE_TEMPLATES];
}
