import { useCallback, useEffect, useState } from 'react';

import type { FilterTemplateKey, ReportPresetFilterTemplate } from '@matricarmz/shared';

/**
 * Шаблоны фильтров для СПИСКОВ программы (промт КАРМАНА #181).
 *
 * Механизм — тот же, что у отчётов по пресетам: именованные наборы лежат в профиле
 * пользователя, едут за оператором на другой компьютер и хранят значения фильтров,
 * перечень включённых ступеней и перечень отключённых. Новая сущность не заводится:
 * список двигателей берёт тот же блоб шаблонов со своим ключом.
 */

export type ListFilterTemplatePayload = {
  /** Значения ступеней: id ступени → выбранные значения (или период). */
  filters: Record<string, unknown>;
  /** Какие ступени шаблон включает. */
  enabled: string[];
  /** Перечень отключённых фильтров (ступени вне шаблона). */
  disabled: string[];
};

/** Событие, которым страница просит оболочку перечитать блоб шаблонов и обновить профиль. */
export const FILTER_TEMPLATES_CHANGED_EVENT = 'matrica:report-templates-changed';

export function useListFilterTemplates(args: { userId?: string; key: FilterTemplateKey }) {
  const userId = args.userId ?? '';
  const key = args.key;
  const [templates, setTemplates] = useState<ReportPresetFilterTemplate[]>([]);
  const [status, setStatus] = useState('');

  const reload = useCallback(async () => {
    try {
      const r = await window.matrica.reports.filterTemplatesList({ userId, presetId: key });
      if (r.ok) setTemplates(r.templates);
    } catch {
      // Шаблоны недоступны — список работает, шаблоны просто не показываются.
    }
  }, [userId, key]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const save = useCallback(
    async (name: string, payload: ListFilterTemplatePayload): Promise<boolean> => {
      const trimmed = name.trim();
      if (!trimmed) {
        setStatus('Введите название шаблона');
        return false;
      }
      const r = await window.matrica.reports.filterTemplateSave({
        userId,
        presetId: key,
        template: {
          name: trimmed,
          filters: payload.filters,
          disabled: payload.disabled,
          enabled: payload.enabled,
        },
      });
      if (!r.ok) {
        setStatus(`Ошибка сохранения шаблона: ${r.error}`);
        return false;
      }
      setTemplates(r.templates);
      setStatus(`Шаблон «${trimmed}» сохранён`);
      // Роуминг: оболочка перечитывает блоб и отправляет секцию профиля.
      window.dispatchEvent(new Event(FILTER_TEMPLATES_CHANGED_EVENT));
      return true;
    },
    [userId, key],
  );

  const remove = useCallback(
    async (templateId: string): Promise<void> => {
      const r = await window.matrica.reports.filterTemplateDelete({ userId, presetId: key, templateId });
      if (!r.ok) {
        setStatus(`Ошибка удаления шаблона: ${r.error}`);
        return;
      }
      setTemplates(r.templates);
      setStatus('Шаблон удалён');
      window.dispatchEvent(new Event(FILTER_TEMPLATES_CHANGED_EVENT));
    },
    [userId, key],
  );

  return { templates, status, setStatus, save, remove, reload };
}
