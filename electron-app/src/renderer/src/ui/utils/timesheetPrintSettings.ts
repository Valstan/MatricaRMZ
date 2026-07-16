// Настройки печати табеля (размеры шрифтов по блокам) — localStorage этой машины,
// по образцу woPrintTemplates.ts (печать нарядов). Между машинами не синхронизируются.
import type { TimesheetPrintSettings } from '@matricarmz/shared';

const KEY = 'matrica:timesheetPrintSettings';

export function loadTimesheetPrintSettings(): TimesheetPrintSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as TimesheetPrintSettings) : {};
  } catch {
    return {};
  }
}

export function saveTimesheetPrintSettings(settings: TimesheetPrintSettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // квота/приватный режим — настройки просто не сохранятся
  }
}
