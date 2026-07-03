import type { WorkOrderPrintSettings } from '@matricarmz/shared';

/**
 * Шаблоны и умолчания настроек печати наряда. Хранятся локально (localStorage) — это
 * пресеты вёрстки оператора (размеры шрифта, заголовок, дата), не данные наряда.
 * За оператором между машинами пока НЕ следуют (потенциальный апгрейд — бэкенд-синк).
 */
export type WoPrintTemplate = { id: string; name: string; settings: WorkOrderPrintSettings };

const TEMPLATES_KEY = 'matrica:woPrintTemplates';
const DEFAULTS_KEY = 'matrica:woPrintDefaults'; // { [workOrderKind]: WorkOrderPrintSettings }

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return (parsed ?? fallback) as T;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* localStorage недоступен/переполнен — игнор, пресеты не критичны */
  }
}

/**
 * Дата печати — данные конкретного наряда, не вёрстка: в шаблонах/умолчаниях она
 * «замораживала» одну дату для всех нарядов вида. Вырезаем и при сохранении, и при
 * чтении (чистит уже сохранённые залипшие даты у операторов).
 */
function stripOrderScoped(settings: WorkOrderPrintSettings): WorkOrderPrintSettings {
  const { orderDateOverride: _drop, ...rest } = settings;
  return rest;
}

function newId(): string {
  try {
    return window.crypto.randomUUID();
  } catch {
    return `tpl_${Math.random().toString(36).slice(2)}`;
  }
}

export function loadWoPrintTemplates(): WoPrintTemplate[] {
  const list = readJson<WoPrintTemplate[]>(TEMPLATES_KEY, []);
  return Array.isArray(list)
    ? list
        .filter((t) => t && typeof t.id === 'string' && typeof t.name === 'string')
        .map((t) => ({ ...t, settings: stripOrderScoped(t.settings ?? {}) }))
    : [];
}

/** Сохранить шаблон под именем. Имя уникально: при совпадении перезаписывает существующий. */
export function saveWoPrintTemplate(name: string, settings: WorkOrderPrintSettings): WoPrintTemplate[] {
  const trimmed = name.trim();
  if (!trimmed) return loadWoPrintTemplates();
  const list = loadWoPrintTemplates();
  const existing = list.find((t) => t.name.toLowerCase() === trimmed.toLowerCase());
  const stored = stripOrderScoped(settings);
  const next = existing
    ? list.map((t) => (t.id === existing.id ? { ...t, settings: stored } : t))
    : [...list, { id: newId(), name: trimmed, settings: stored }];
  writeJson(TEMPLATES_KEY, next);
  return next;
}

export function deleteWoPrintTemplate(id: string): WoPrintTemplate[] {
  const next = loadWoPrintTemplates().filter((t) => t.id !== id);
  writeJson(TEMPLATES_KEY, next);
  return next;
}

/** Умолчание печати для вида наряда (применяется, если у наряда нет своих настроек). */
export function loadWoPrintDefault(kind: string | null | undefined): WorkOrderPrintSettings | undefined {
  const key = String(kind ?? '').trim();
  if (!key) return undefined;
  const map = readJson<Record<string, WorkOrderPrintSettings>>(DEFAULTS_KEY, {});
  const v = map?.[key];
  return v && typeof v === 'object' ? stripOrderScoped(v) : undefined;
}

export function saveWoPrintDefault(kind: string | null | undefined, settings: WorkOrderPrintSettings): void {
  const key = String(kind ?? '').trim();
  if (!key) return;
  const map = readJson<Record<string, WorkOrderPrintSettings>>(DEFAULTS_KEY, {});
  writeJson(DEFAULTS_KEY, { ...map, [key]: stripOrderScoped(settings) });
}

export function clearWoPrintDefault(kind: string | null | undefined): void {
  const key = String(kind ?? '').trim();
  if (!key) return;
  const map = readJson<Record<string, WorkOrderPrintSettings>>(DEFAULTS_KEY, {});
  if (!(key in map)) return;
  const next = { ...map };
  delete next[key];
  writeJson(DEFAULTS_KEY, next);
}
