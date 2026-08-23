import type { ChatDeepLinkPayload } from '@matricarmz/shared';

const PREFIX = 'favorite:';

type FavoritePayload = { title: string; link: ChatDeepLinkPayload };

export function buildFavoriteShortcut(tab: string, entityId: string, title: string): string | null {
  const safeTab = String(tab ?? '').trim();
  const safeId = String(entityId ?? '').trim();
  const safeTitle = String(title ?? '').trim().slice(0, 140);
  if (!safeTab || !safeId || !safeTitle) return null;
  const link = {
    kind: 'app_link',
    tab: safeTab,
    cardKind: safeTab,
    entityId: safeId,
    breadcrumbs: [safeTitle],
  } as ChatDeepLinkPayload;
  return `${PREFIX}${encodeURIComponent(JSON.stringify({ title: safeTitle, link } satisfies FavoritePayload))}`;
}

export function parseFavoriteShortcut(value: string): FavoritePayload | null {
  const source = String(value ?? '').trim();
  if (!source.toLowerCase().startsWith(PREFIX)) return null;
  try {
    const raw = JSON.parse(decodeURIComponent(source.slice(PREFIX.length))) as Partial<FavoritePayload>;
    const title = String(raw.title ?? '').trim();
    const link = raw.link;
    if (!title || !link || link.kind !== 'app_link' || typeof link.tab !== 'string') return null;
    return { title, link };
  } catch {
    return null;
  }
}

export type PinnedTile = {
  shortcutId: string;
  icon: string;
  title: string;
  gradient: string;
  link: ChatDeepLinkPayload;
};

export const TAB_SHORTCUT_META: Record<string, { icon: string; title: string; gradient: string }> = {
  engines: { icon: '⚙️', title: 'Двигатели', gradient: 'linear-gradient(135deg, #1d4ed8 0%, #0ea5e9 100%)' },
  engine_brands: { icon: '🏷️', title: 'Марки двигателей', gradient: 'linear-gradient(135deg, #2563eb 0%, #60a5fa 100%)' },
  parts: { icon: '🧩', title: 'Детали', gradient: 'linear-gradient(135deg, #7c3aed 0%, #a855f7 100%)' },
  part_templates: { icon: '📋', title: 'Справочник деталей', gradient: 'linear-gradient(135deg, #6d28d9 0%, #8b5cf6 100%)' },
  engine_assembly_bom: { icon: '🧮', title: 'BOM двигателей', gradient: 'linear-gradient(135deg, #0f766e 0%, #14b8a6 100%)' },
  requests: { icon: '📦', title: 'Заявки', gradient: 'linear-gradient(135deg, #0f766e 0%, #10b981 100%)' },
  work_orders: { icon: '🛠️', title: 'Наряды', gradient: 'linear-gradient(135deg, #0f766e 0%, #14b8a6 100%)' },
  tools: { icon: '🔧', title: 'Инструменты', gradient: 'linear-gradient(135deg, #059669 0%, #22c55e 100%)' },
  tool_accounting: { icon: '📋', title: 'Учёт инструментов', gradient: 'linear-gradient(135deg, #047857 0%, #34d399 100%)' },
  nomenclature: { icon: '🗃️', title: 'Номенклатура', gradient: 'linear-gradient(135deg, #0369a1 0%, #0ea5e9 100%)' },
  stock_balances: { icon: '📊', title: 'Остатки', gradient: 'linear-gradient(135deg, #0284c7 0%, #38bdf8 100%)' },
  stock_documents: { icon: '📄', title: 'Документы', gradient: 'linear-gradient(135deg, #0ea5e9 0%, #22d3ee 100%)' },
  stock_receipts: { icon: '📥', title: 'Приход', gradient: 'linear-gradient(135deg, #0ea5e9 0%, #22d3ee 100%)' },
  stock_issues: { icon: '📤', title: 'Расход', gradient: 'linear-gradient(135deg, #0891b2 0%, #06b6d4 100%)' },
  stock_transfers: { icon: '🔄', title: 'Перемещения', gradient: 'linear-gradient(135deg, #0c4a6e 0%, #0284c7 100%)' },
  stock_inventory: { icon: '📋', title: 'Инвентаризация', gradient: 'linear-gradient(135deg, #075985 0%, #0284c7 100%)' },
  contracts: { icon: '📄', title: 'Контракты', gradient: 'linear-gradient(135deg, #7c3aed 0%, #c084fc 100%)' },
  counterparties: { icon: '🤝', title: 'Контрагенты', gradient: 'linear-gradient(135deg, #9333ea 0%, #ec4899 100%)' },
  employees: { icon: '👥', title: 'Сотрудники', gradient: 'linear-gradient(135deg, #0f766e 0%, #14b8a6 100%)' },
  timesheets: { icon: '🗓️', title: 'Табель', gradient: 'linear-gradient(135deg, #0f766e 0%, #14b8a6 100%)' },
  reports: { icon: '📊', title: 'Отчёты', gradient: 'linear-gradient(135deg, #be185d 0%, #ec4899 100%)' },
  changes: { icon: '🧾', title: 'Изменения', gradient: 'linear-gradient(135deg, #6b7280 0%, #94a3b8 100%)' },
  audit: { icon: '🔍', title: 'Журнал', gradient: 'linear-gradient(135deg, #374151 0%, #6b7280 100%)' },
  notes: { icon: '📝', title: 'Заметки', gradient: 'linear-gradient(135deg, #c2410c 0%, #f97316 100%)' },
  masterdata: { icon: '🗂️', title: 'Справочники', gradient: 'linear-gradient(135deg, #0f766e 0%, #10b981 100%)' },
  settings: { icon: '⚙️', title: 'Настройки', gradient: 'linear-gradient(135deg, #475569 0%, #94a3b8 100%)' },
};

/**
 * Плитка «Быстрого запуска» по строковому id легаси-списка (`tab:`, `report:`, `favorite:`).
 * «Мой круг» его больше не рисует — резолвер живёт ради одноразового переезда списка в
 * ярлыки Рабочего стола (этап B): подпись и ссылка берутся отсюда, как и раньше.
 */
export function resolveQuickStartTile(shortcutId: string, reportPresets?: Array<{ id: string; title: string }>): PinnedTile | null {
  const normalized = String(shortcutId ?? '').trim();
  if (!normalized) return null;
  const favorite = parseFavoriteShortcut(normalized);
  if (favorite) {
    return {
      shortcutId: normalized,
      icon: favorite.link.tab === 'report_preset' ? '📊' : '⭐',
      title: favorite.title,
      gradient: favorite.link.tab === 'report_preset'
        ? 'linear-gradient(135deg, #be185d 0%, #ec4899 100%)'
        : 'linear-gradient(135deg, #0f766e 0%, #14b8a6 100%)',
      link: favorite.link,
    };
  }
  if (normalized.toLowerCase().startsWith('tab:')) {
    const tabId = normalized.slice(4);
    const meta = TAB_SHORTCUT_META[tabId];
    if (!meta) return null;
    return { shortcutId: normalized, icon: meta.icon, title: meta.title, gradient: meta.gradient, link: { kind: 'app_link', tab: tabId as any, breadcrumbs: [meta.title] } };
  }
  const reportMatch = /^report:(.+)$/i.exec(normalized);
  if (reportMatch) {
    const presetId = String(reportMatch[1] ?? '').trim();
    if (!presetId) return null;
    const preset = reportPresets?.find((p) => p.id === presetId);
    const title = (preset?.title ?? '').trim() || `Отчёт (${presetId})`;
    return {
      shortcutId: normalized,
      icon: '📊',
      title,
      gradient: 'linear-gradient(135deg, #be185d 0%, #ec4899 100%)',
      link: {
        kind: 'app_link',
        tab: 'report_preset' as any,
        reportPresetId: presetId as any,
        breadcrumbs: [title],
      },
    };
  }
  return null;
}
