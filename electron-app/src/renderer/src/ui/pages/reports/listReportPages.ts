import type React from 'react';

import type { EngineListItem, ReportPresetId } from '@matricarmz/shared';

import { EngineFactoryStagesReportPage } from './EngineFactoryStagesReportPage.js';
import { EnginesReportPage } from './EnginesReportPage.js';

/**
 * Рамка «отчёт как список» (владелец 15.09.2026: «отчёты должны стать такими же списками,
 * как список двигателей — вверху панель фильтров, внизу список»).
 *
 * Пресет с `presentation: 'list'` в реестре `REPORT_PRESET_DEFINITIONS` регистрируется
 * здесь компонентом-списком; `ReportPresetPage` делегирует ему экран целиком. Так отчёт
 * бесплатно получает плитку каталога, избранное, историю, ярлык на Верстак, восстановление
 * вкладки и deep-link — всё, что уже умеет вкладка `report_preset`. Рецепт переноса
 * остальных отчётов — `docs/plans/reports-as-lists-2026-09.md`.
 */
export type ListReportPageProps = {
  /** Каталог двигателей приложения — списки строятся из уже загруженных данных. */
  engines: EngineListItem[];
  canExport: boolean;
  onOpenEngine: (id: string) => void;
  onBack: () => void;
};

export const LIST_REPORT_PAGES: Partial<Record<ReportPresetId, React.ComponentType<ListReportPageProps>>> = {
  engine_factory_stages: EngineFactoryStagesReportPage,
  engines: EnginesReportPage,
};
