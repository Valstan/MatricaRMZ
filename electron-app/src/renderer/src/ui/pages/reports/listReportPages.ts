import type React from 'react';

import type { EngineListItem } from '@matricarmz/shared';

import { EnginesNowAtPlantReportPage } from './EnginesNowAtPlantReportPage.js';
import { EnginesReportPage } from './EnginesReportPage.js';
import { WorkSheetsReportPage } from './WorkSheetsReportPage.js';

/**
 * Рамка «отчёт как список» (владелец 15.09.2026: «отчёты должны стать такими же списками,
 * как список двигателей — вверху панель фильтров, внизу список»).
 *
 * Пресет с `presentation: 'list'` в реестре `REPORT_PRESET_DEFINITIONS` регистрируется
 * здесь компонентом-списком; `ReportPresetPage` делегирует ему экран целиком. Так отчёт
 * бесплатно получает плитку каталога, избранное, историю, ярлык на Верстак, восстановление
 * вкладки и deep-link — всё, что уже умеет вкладка `report_preset`. Рецепт переноса
 * остальных отчётов — `docs/plans/reports-as-lists-2026-09.md`.
 *
 * «Сейчас на заводе» (`engines_now_at_plant`, владелец 14.10.2026) поглотил прежние
 * `engine_factory_stages` и `engines_at_plant`: оба id остались алиасами на ту же
 * страницу (см. `REPORT_PRESET_ALIASES`), ярлыки/история/избранное открывают по ним.
 */
export type ListReportPageProps = {
  /** Каталог двигателей приложения — списки строятся из уже загруженных данных. */
  engines: EngineListItem[];
  canExport: boolean;
  onOpenEngine: (id: string) => void;
  onBack: () => void;
};

export const LIST_REPORT_PAGES: Partial<Record<string, React.ComponentType<ListReportPageProps>>> = {
  engines_now_at_plant: EnginesNowAtPlantReportPage,
  engine_factory_stages: EnginesNowAtPlantReportPage,
  engines_at_plant: EnginesNowAtPlantReportPage,
  engines: EnginesReportPage,
  work_sheets: WorkSheetsReportPage,
};
