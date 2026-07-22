import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type {
  AuthStatus,
  ChatDeepLinkPayload,
  EngineDetails,
  EngineListItem,
  SyncProgressEvent,
  SyncStatus,
  AiAgentContext,
  AiAgentEvent,
  UiControlSettings,
  UiDisplayPrefs,
  UiShellPrefs,
  V2Session,
  UiShellVersion,
  V2Prefs,
  ReleaseWelcomeContent,
  ReportPresetId,
  WorkOrderPayload,
  SupplyRequestPayload,
} from '@matricarmz/shared';
import {
  ACCESS_SECTION_CATALOG,
  ENGINE_INTERNAL_NUMBER_CODE,
  ENGINE_INTERNAL_NUMBER_YEAR_CODE,
  formatEngineInternalNumber,
  WorkOrderKind,
  DEFAULT_UI_CONTROL_SETTINGS,
  DEFAULT_UI_SHELL_PREFS,
  sanitizeUiShellPrefs,
  DEFAULT_UI_DISPLAY_PREFS,
  DEFAULT_UI_PRESET_ID,
  sanitizeUiControlSettings,
  sanitizeUiPresetId,
  uiControlToDisplayPrefs,
  withUiControlPresetApplied,
} from '@matricarmz/shared';

import { Page } from './layout/Page.js';
import { Tabs, type MenuGroupId, type MenuTabId, type TabId, type TabsLayoutPrefs, GROUP_LABELS, MENU_TAB_LABELS, deriveMenuState } from './layout/Tabs.js';
import { deriveUiCaps } from './auth/permissions.js';

// «Доступ по разделам» (Ф1): таб меню → раздел. Табы вне разделов (заметки, история,
// настройки) не гейтятся. Membership читается из локальной БД по логину (fail-open:
// null = атрибут не засеян или superadmin → меню как раньше).
const SECTION_BY_TAB: ReadonlyMap<string, string> = new Map(
  ACCESS_SECTION_CATALOG.flatMap((s) => s.menuTabs.map((t) => [t, s.id] as const)),
);
import { Button } from './components/Button.js';
import { ChatPanel } from './components/ChatPanel.js';
import { AccountSwitchDialog } from './components/AccountSwitchDialog.js';
import { ListContextMenu } from './components/ListContextMenu.js';
import { ErrorBoundary } from './components/ErrorBoundary.js';
import { GlobalInputAssist } from './components/GlobalInputAssist.js';
import { GlobalSearchOverlay } from './components/GlobalSearchOverlay.js';
import { AiAgentChat, type AiAgentChatHandle } from './components/AiAgentChat.js';
import { ListColumnsToggle } from './components/ListColumnsToggle.js';
import { useAiAgentTracker } from './ai/useAiAgentTracker.js';
import { useTabFocusSelectAll } from './hooks/useTabFocusSelectAll.js';
import { useAutoGrowInputs } from './hooks/useAutoGrowInputs.js';
import { useAdaptiveListTables } from './hooks/useAdaptiveListTables.js';
import { useListColumnsMode } from './hooks/useListColumnsMode.js';
import { useUiMode, useTabletDevice } from './hooks/useUiMode.js';
import { useLiveDataRefresh } from './hooks/useLiveDataRefresh.js';
import { resolveDeepLinkRoute, searchHitToRoute, type DeepLinkRoute } from './utils/deepLinkRouting.js';
import { loadContractActivityAlerts } from './utils/contractAlerts.js';
import { pollWhenVisible } from './utils/pollWhenVisible.js';
import { logUiUsage } from './utils/uiUsageLog.js';
import type { CardCloseActions } from './cardCloseTypes.js';
import { PRODUCTS_PRESET, SERVICES_PRESET } from './pages/nomenclatureDirectoryPresets.js';
import { V2Shell } from './shellV2/V2Shell.js';
import { V2_LIST_TABS } from './shellV2/v2ButtonCatalog.js';

type RecentVisitEntry = {
  id: string;
  at: number;
  title: string;
  link: ChatDeepLinkPayload;
};

const RECENT_VISITS_LIMIT = 10;
const NAVIGATION_HISTORY_LIMIT = 10;
type StockDocumentParentTab = 'stock_documents' | 'stock_receipts' | 'stock_issues' | 'stock_transfers' | 'stock_inventory';

type AppNavigationStep = {
  id: string;
  at: number;
  link: ChatDeepLinkPayload;
};

type QuickStartScoreEntry = {
  daily: Record<string, number>;
  lastAt: number;
};

type CurrentUserProfile = {
  fullName: string;
  position: string;
  sectionId: string | null;
  sectionName: string | null;
};

const QUICK_START_DAY_MS = 24 * 60 * 60 * 1000;
const QUICK_START_RATING_WINDOW_DAYS = 10;
const QUICK_START_RATING_WINDOW_MS = QUICK_START_DAY_MS * QUICK_START_RATING_WINDOW_DAYS;

const pageModules = (import.meta as unknown as { glob: (pattern: string) => Record<string, () => Promise<unknown>> }).glob('./pages/*.tsx');

function lazyPage(modulePath: keyof typeof pageModules, exportName: string) {
  return React.lazy(async () => {
    const loader = pageModules[modulePath];
    if (!loader) throw new Error(`Page module not found: ${String(modulePath)}`);
    const module = (await loader()) as Record<string, unknown>;
    const component = module[exportName];
    if (!component) throw new Error(`Page export "${exportName}" not found: ${String(modulePath)}`);
    return { default: component as React.ComponentType<any> };
  });
}

const EnginesPage = lazyPage('./pages/EnginesPage.tsx', 'EnginesPage');
const EngineDetailsPage = lazyPage('./pages/EngineDetailsPage.tsx', 'EngineDetailsPage');
const EngineBrandsPage = lazyPage('./pages/EngineBrandsPage.tsx', 'EngineBrandsPage');
const EngineBrandDetailsPage = lazyPage('./pages/EngineBrandDetailsPage.tsx', 'EngineBrandDetailsPage');
const EngineBrandGroupsPage = lazyPage('./pages/EngineBrandGroupsPage.tsx', 'EngineBrandGroupsPage');
const EngineBrandGroupDetailsPage = lazyPage('./pages/EngineBrandGroupDetailsPage.tsx', 'EngineBrandGroupDetailsPage');
const ChangesPage = lazyPage('./pages/ChangesPage.tsx', 'ChangesPage');
const ReportsCatalogPage = lazyPage('./pages/ReportsCatalogPage.tsx', 'ReportsCatalogPage');
const ReportPresetPage = lazyPage('./pages/ReportPresetPage.tsx', 'ReportPresetPage');
const MasterdataPage = lazyPage('./pages/AdminPage.tsx', 'MasterdataPage');
const CounterpartiesPage = lazyPage('./pages/CounterpartiesPage.tsx', 'CounterpartiesPage');
const CounterpartyDetailsPage = lazyPage('./pages/CounterpartyDetailsPage.tsx', 'CounterpartyDetailsPage');
const ContractsPage = lazyPage('./pages/ContractsPage.tsx', 'ContractsPage');
const ContractDetailsPage = lazyPage('./pages/ContractDetailsPage.tsx', 'ContractDetailsPage');
const AuthPage = lazyPage('./pages/AuthPage.tsx', 'AuthPage');
const SupplyRequestsPage = lazyPage('./pages/SupplyRequestsPage.tsx', 'SupplyRequestsPage');
const SupplyRequestDetailsPage = lazyPage('./pages/SupplyRequestDetailsPage.tsx', 'SupplyRequestDetailsPage');
const WorkOrdersPage = lazyPage('./pages/WorkOrdersPage.tsx', 'WorkOrdersPage');
const WorkOrderDetailsPage = lazyPage('./pages/WorkOrderDetailsPage.tsx', 'WorkOrderDetailsPage');
const WorkOrderTemplatesPage = lazyPage('./pages/WorkOrderTemplatesPage.tsx', 'WorkOrderTemplatesPage');
const PartsPage = lazyPage('./pages/PartsPage.tsx', 'PartsPage');
const ToolsPage = lazyPage('./pages/ToolsPage.tsx', 'ToolsPage');
const ToolDetailsPage = lazyPage('./pages/ToolDetailsPage.tsx', 'ToolDetailsPage');
const ToolPropertiesPage = lazyPage('./pages/ToolPropertiesPage.tsx', 'ToolPropertiesPage');
const ToolPropertyDetailsPage = lazyPage('./pages/ToolPropertyDetailsPage.tsx', 'ToolPropertyDetailsPage');
const EmployeesPage = lazyPage('./pages/EmployeesPage.tsx', 'EmployeesPage');
const TimesheetsPage = lazyPage('./pages/TimesheetsPage.tsx', 'TimesheetsPage');
const TimesheetGridPage = lazyPage('./pages/TimesheetGridPage.tsx', 'TimesheetGridPage');
const EmployeeDetailsPage = lazyPage('./pages/EmployeeDetailsPage.tsx', 'EmployeeDetailsPage');
const MasterdataWorkshopsPage = lazyPage('./pages/MasterdataWorkshopsPage.tsx', 'MasterdataWorkshopsPage');
const WarehouseLocationsPage = lazyPage('./pages/WarehouseLocationsPage.tsx', 'WarehouseLocationsPage');
const WarehouseLocationsAdminPage = lazyPage('./pages/WarehouseLocationsAdminPage.tsx', 'WarehouseLocationsAdminPage');
const SupplyToolMovementsPage = lazyPage('./pages/SupplyToolMovementsPage.tsx', 'SupplyToolMovementsPage');
const ServicesPage = lazyPage('./pages/ServicesPage.tsx', 'ServicesPage');
const UserScreensPage = lazyPage('./pages/UserScreensPage.tsx', 'UserScreensPage');
const UserScreenViewPage = lazyPage('./pages/UserScreenViewPage.tsx', 'UserScreenViewPage');
const ScreenEditorPage = lazyPage('./pages/ScreenEditorPage.tsx', 'ScreenEditorPage');
const ServicesByBrandPage = lazyPage('./pages/ServicesByBrandPage.tsx', 'ServicesByBrandPage');
const NomenclaturePage = lazyPage('./pages/NomenclaturePage.tsx', 'NomenclaturePage');
const PartsDedupePage = lazyPage('./pages/PartsDedupePage.tsx', 'PartsDedupePage');
const EmptyCardsCleanupPage = lazyPage('./pages/EmptyCardsCleanupPage.tsx', 'EmptyCardsCleanupPage');
const DraftsPage = lazyPage('./pages/DraftsPage.tsx', 'DraftsPage');
const NomenclatureDetailsPage = lazyPage('./pages/NomenclatureDetailsPage.tsx', 'NomenclatureDetailsPage');
const StockBalancesPage = lazyPage('./pages/StockBalancesPage.tsx', 'StockBalancesPage');
const StockDocumentsPage = lazyPage('./pages/StockDocumentsPage.tsx', 'StockDocumentsPage');
const StockDocumentDetailsPage = lazyPage('./pages/StockDocumentDetailsPage.tsx', 'StockDocumentDetailsPage');
const StockInventoryPage = lazyPage('./pages/StockInventoryPage.tsx', 'StockInventoryPage');
const RepairFundAuditPage = lazyPage('./pages/RepairFundAuditPage.tsx', 'RepairFundAuditPage');
const WarehouseAnalyticsPage = lazyPage('./pages/WarehouseAnalyticsPage.tsx', 'WarehouseAnalyticsPage');
const WorkshopStatsPage = lazyPage('./pages/WorkshopStatsPage.tsx', 'WorkshopStatsPage');
const CustomReportsPage = lazyPage('./pages/CustomReportsPage.tsx', 'CustomReportsPage');
const AccessSectionsPage = lazyPage('./pages/AccessSectionsPage.tsx', 'AccessSectionsPage');
const EngineAssemblyBomPage = lazyPage('./pages/EngineAssemblyBomPage.tsx', 'EngineAssemblyBomPage');
const EngineAssemblyBomDetailsPage = lazyPage('./pages/EngineAssemblyBomDetailsPage.tsx', 'EngineAssemblyBomDetailsPage');
const SimpleMasterdataDetailsPage = lazyPage('./pages/SimpleMasterdataDetailsPage.tsx', 'SimpleMasterdataDetailsPage');
const SettingsPage = lazyPage('./pages/SettingsPage.tsx', 'SettingsPage');
const NotesPage = lazyPage('./pages/NotesPage.tsx', 'NotesPage');
const HistoryPage = lazyPage('./pages/HistoryPage.tsx', 'HistoryPage');
const SuperadminAuditPage = lazyPage('./pages/SuperadminAuditPage.tsx', 'SuperadminAuditPage');

function renderEnginePartSvg(kind: 'gear' | 'piston' | 'bolt' | 'nut' | 'ring' | 'rod' | 'valve' | 'spark') {
  switch (kind) {
    case 'gear':
      return (
        <svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
          <g fill="currentColor">
            <path d="M30 2h4l1 6 6 1 3-5 3.5 2-1 6 5 4 5-3 2.5 3-4 5 2 6-6 1-1 6 5 3-2.5 3.5-6-1-4 5 3 5-3 2.5-5-3-6 1-1 6h-4l-1-6-6-1-3 5-3.5-2.5 3-5-5-4-5 3-2.5-3.5 5-4-2-6 6-1 1-6-5-3 2.5-3.5 6 1 4-5-3-5 3-2.5 5 3 6-1z" />
            <circle cx="32" cy="32" r="9" fill="rgba(15,23,42,0.55)" />
            <circle cx="32" cy="32" r="5.5" fill="currentColor" />
          </g>
        </svg>
      );
    case 'piston':
      return (
        <svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
          <g fill="currentColor">
            <rect x="18" y="6" width="28" height="22" rx="3" />
            <rect x="20" y="9" width="24" height="2" fill="rgba(15,23,42,0.5)" />
            <rect x="20" y="13" width="24" height="2" fill="rgba(15,23,42,0.5)" />
            <rect x="20" y="17" width="24" height="2" fill="rgba(15,23,42,0.5)" />
            <rect x="28" y="28" width="8" height="14" />
            <circle cx="32" cy="50" r="9" fill="none" stroke="currentColor" strokeWidth="4" />
            <circle cx="32" cy="50" r="3" />
          </g>
        </svg>
      );
    case 'bolt':
      return (
        <svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
          <g fill="currentColor">
            <polygon points="32,4 50,14 50,28 32,38 14,28 14,14" />
            <polygon points="32,12 44,18 44,26 32,32 20,26 20,18" fill="rgba(15,23,42,0.5)" />
            <rect x="29" y="34" width="6" height="26" />
            <path d="M28 38h8M28 42h8M28 46h8M28 50h8M28 54h8" stroke="rgba(15,23,42,0.45)" strokeWidth="1.5" />
          </g>
        </svg>
      );
    case 'nut':
      return (
        <svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
          <g fill="currentColor">
            <polygon points="32,6 54,18 54,46 32,58 10,46 10,18" />
            <circle cx="32" cy="32" r="11" fill="rgba(15,23,42,0.6)" />
            <circle cx="32" cy="32" r="7" fill="none" stroke="currentColor" strokeWidth="1.5" opacity="0.6" />
          </g>
        </svg>
      );
    case 'ring':
      return (
        <svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
          <g fill="none" stroke="currentColor" strokeWidth="5">
            <circle cx="32" cy="32" r="22" />
          </g>
          <path d="M30 8h4l-1 4-2 0z" fill="currentColor" />
        </svg>
      );
    case 'rod':
      return (
        <svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
          <g fill="currentColor">
            <circle cx="32" cy="12" r="9" />
            <circle cx="32" cy="12" r="4" fill="rgba(15,23,42,0.6)" />
            <path d="M28 18 L24 50 L40 50 L36 18 Z" />
            <ellipse cx="32" cy="54" rx="14" ry="6" />
            <ellipse cx="32" cy="54" rx="7" ry="3" fill="rgba(15,23,42,0.6)" />
          </g>
        </svg>
      );
    case 'valve':
      return (
        <svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
          <g fill="currentColor">
            <ellipse cx="32" cy="50" rx="16" ry="8" />
            <ellipse cx="32" cy="50" rx="10" ry="4" fill="rgba(15,23,42,0.55)" />
            <rect x="29" y="8" width="6" height="40" />
            <rect x="26" y="6" width="12" height="4" />
          </g>
        </svg>
      );
    case 'spark':
      return (
        <svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
          <g fill="currentColor">
            <rect x="26" y="4" width="12" height="10" rx="1.5" />
            <polygon points="22,16 42,16 40,22 24,22" />
            <polygon points="24,24 40,24 38,32 26,32" fill="rgba(15,23,42,0.55)" />
            <rect x="28" y="34" width="8" height="14" />
            <polygon points="30,48 34,48 32,60" />
          </g>
        </svg>
      );
    default:
      return null;
  }
}

function recentVisitsStorageKey(userId: string) {
  return `matrica:recent-visits:${userId}`;
}

function quickStartRatingsStorageKey(userId: string) {
  return `matrica:history:quick-start-ratings:${userId}`;
}

// Default «Табель» shortcut in «Мой круг»: seeded once per client (this flag), so the
// client can later remove the tile (right-click → «Убрать из Моего круга») and it stays
// removed instead of being re-added on every login.
const TIMESHEET_SHORTCUT_ID = 'tab:timesheets';
function timesheetShortcutSeededKey(userId: string) {
  return `matrica:shortcuts:seeded:timesheets:${userId}`;
}

function appLinkSignature(link: ChatDeepLinkPayload) {
  return JSON.stringify({
    tab: link.tab,
    engineId: link.engineId ?? null,
    engineBrandId: link.engineBrandId ?? null,
    requestId: link.requestId ?? null,
    partId: link.partId ?? null,
    toolId: link.toolId ?? null,
    toolPropertyId: link.toolPropertyId ?? null,
    contractId: link.contractId ?? null,
    employeeId: link.employeeId ?? null,
    productId: link.productId ?? null,
    serviceId: link.serviceId ?? null,
    counterpartyId: link.counterpartyId ?? null,
    nomenclatureId: link.nomenclatureId ?? null,
    stockDocumentId: link.stockDocumentId ?? null,
    reportPresetId: link.reportPresetId ?? null,
  });
}

function normalizeQuickStartTab(tab: string): TabId | null {
  const source = String(tab ?? '').trim();
  if (!source || source === 'auth' || source === 'history') return null;
  const direct = source as TabId;
  const parent = CARD_PARENT_TAB[direct];
  return parent ?? direct;
}

function toQuickStartDayBucket(ts: number) {
  return Math.floor(ts / QUICK_START_DAY_MS);
}

function normalizeQuickStartScores(raw: unknown, now = Date.now()): Record<string, QuickStartScoreEntry> {
  if (!raw || typeof raw !== 'object') return {};
  const minBucket = toQuickStartDayBucket(now - QUICK_START_RATING_WINDOW_MS);
  const out: Record<string, QuickStartScoreEntry> = {};
  for (const [tab, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!tab) continue;
    const entry = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
    const legacyScore = Number(entry.score ?? 0);
    const lastAtRaw = Number(entry.lastAt ?? 0);
    const fallbackLastAt = Number.isFinite(lastAtRaw) && lastAtRaw > 0 ? Math.floor(lastAtRaw) : now;
    const rawDaily =
      entry.daily && typeof entry.daily === 'object'
        ? (entry.daily as Record<string, unknown>)
        : legacyScore > 0
          ? { [String(toQuickStartDayBucket(fallbackLastAt))]: legacyScore }
          : {};
    const daily: Record<string, number> = {};
    for (const [bucketKey, countRaw] of Object.entries(rawDaily)) {
      const bucket = Number(bucketKey);
      const count = Number(countRaw);
      if (!Number.isFinite(bucket) || !Number.isFinite(count)) continue;
      if (bucket < minBucket) continue;
      const safeCount = Math.max(0, Math.floor(count));
      if (safeCount <= 0) continue;
      const key = String(Math.floor(bucket));
      daily[key] = Number(daily[key] ?? 0) + safeCount;
    }
    if (Object.keys(daily).length === 0) continue;
    out[tab] = {
      daily,
      lastAt: fallbackLastAt,
    };
  }
  return out;
}

function addQuickStartVisit(
  prev: Record<string, QuickStartScoreEntry>,
  tab: string,
  at = Date.now(),
): Record<string, QuickStartScoreEntry> {
  const normalized = normalizeQuickStartScores(prev, at);
  const bucketKey = String(toQuickStartDayBucket(at));
  const current = normalized[tab] ?? { daily: {}, lastAt: at };
  const nextDaily = { ...current.daily, [bucketKey]: Number(current.daily[bucketKey] ?? 0) + 1 };
  const next = {
    ...normalized,
    [tab]: {
      daily: nextDaily,
      lastAt: at,
    },
  };
  return normalizeQuickStartScores(next, at);
}

function projectQuickStartRatings(scores: Record<string, QuickStartScoreEntry>, now = Date.now()) {
  const normalized = normalizeQuickStartScores(scores, now);
  return Object.entries(normalized)
    .map(([tab, info]) => ({
      tab,
      score: Object.values(info.daily).reduce((sum, value) => sum + Number(value ?? 0), 0),
      lastAt: Number(info.lastAt ?? 0),
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || b.lastAt - a.lastAt);
}

const CHAT_NEW_MESSAGE_SOUND_FILE = './oh-oh-icq-sound.ogg';
const CHAT_PENDING_SOUND_FILE = './melodious-notification-sound.ogg';

function parseRecentVisits(raw: string | null): RecentVisitEntry[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item: any) => ({
        id: String(item?.id ?? ''),
        at: Number(item?.at ?? 0),
        title: String(item?.title ?? '').trim(),
        link: item?.link as ChatDeepLinkPayload,
      }))
      .filter((item) => item.id && item.at > 0 && item.title && item.link?.kind === 'app_link' && typeof item.link?.tab === 'string')
      .slice(0, RECENT_VISITS_LIMIT);
  } catch {
    return [];
  }
}

function upsertRecentVisit(list: RecentVisitEntry[], entry: RecentVisitEntry): RecentVisitEntry[] {
  const signature = appLinkSignature(entry.link);
  const next = [entry, ...(Array.isArray(list) ? list : []).filter((row) => appLinkSignature(row.link) !== signature)];
  return next.slice(0, RECENT_VISITS_LIMIT);
}

function appTabTitle(tab: string): string {
  const labels: Record<string, string> = {
    history: 'История',
    engines: 'Двигатели',
    assembly_forecast: 'Прогноз сборки',
    engine: 'Карточка двигателя',
    engine_brands: 'Марки двигателей',
    engine_brand: 'Карточка марки двигателя',
    engine_brand_groups: 'Группы марок',
    engine_brand_group: 'Карточка группы марок',
    contracts: 'Контракты',
    contract: 'Карточка контракта',
    counterparties: 'Контрагенты',
    counterparty: 'Карточка контрагента',
    requests: 'Заявки',
    request: 'Карточка заявки',
    work_orders: 'Наряды',
    work_order: 'Карточка наряда',
    work_order_templates: 'Шаблоны нарядов',
    parts: 'Детали',
    part: 'Карточка детали',
    tools: 'Инструменты',
    tool: 'Карточка инструмента',
    tool_properties: 'Свойства инструмента',
    tool_property: 'Карточка свойства инструмента',
    employees: 'Сотрудники',
    employee: 'Карточка сотрудника',
    timesheets: 'Табель',
    timesheet: 'Карточка табеля',
    products: 'Товары',
    product: 'Карточка товара',
    services: 'Услуги',
    services_by_brand: 'Услуги по маркам',
    service: 'Карточка услуги',
    nomenclature: 'Номенклатура',
    parts_dedupe: 'Дубли номенклатуры',
    empty_cards: 'Пустые карточки',
    drafts: 'Черновики',
    engine_assembly_bom: 'BOM двигателей',
    engine_assembly_bom_item: 'Карточка BOM двигателя',
    nomenclature_item: 'Карточка номенклатуры',
    stock_balances: 'Остатки',
    stock_receipts: 'Приход',
    stock_issues: 'Расход',
    stock_transfers: 'Перемещения',
    stock_documents: 'Складские документы',
    stock_document: 'Карточка складского документа',
    stock_inventory: 'Инвентаризация',
    reports: 'Отчёты',
    report_preset: 'Шаблон отчёта',
    changes: 'Изменения',
    notes: 'Заметки',
    settings: 'Настройки',
    masterdata: 'Справочники',
    user_screens: 'Мои экраны',
    user_screen: 'Экран',
  };
  return labels[tab] ?? tab;
}

const CARD_PARENT_TAB: Partial<Record<TabId, TabId>> = {
  engine: 'engines',
  engine_brand: 'engine_brands',
  engine_brand_group: 'engine_brand_groups',
  request: 'requests',
  work_order: 'work_orders',
  part: 'parts',
  tool: 'tools',
  tool_property: 'tool_properties',
  employee: 'employees',
  timesheet: 'timesheets',
  contract: 'contracts',
  counterparty: 'counterparties',
  product: 'nomenclature',
  service: 'nomenclature',
  nomenclature_item: 'nomenclature',
  engine_assembly_bom_item: 'engine_assembly_bom',
  stock_document: 'stock_documents',
  report_preset: 'reports',
  user_screen: 'user_screens',
};

const CARD_DETAIL_TABS: ReadonlyArray<TabId> = [
  'engine',
  'engine_brand',
  'engine_brand_group',
  'request',
  'work_order',
  'part',
  'tool',
  'tool_property',
  'employee',
  'contract',
  'counterparty',
  'product',
  'service',
  'nomenclature_item',
  'engine_assembly_bom_item',
  'stock_document',
  'report_preset',
  'user_screen',
];

export function App() {
  const [fatalError, setFatalError] = useState<{ message: string; stack?: string | null } | null>(null);
  const [fatalOpen, setFatalOpen] = useState(false);
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const [incrementalSyncUi, setIncrementalSyncUi] = useState<{
    active: boolean;
    progress: number | null;
    activity?: string | null;
    error?: string | null;
  } | null>(null);
  const incrementalSyncCloseTimer = useRef<number | null>(null);
  const [fullSyncUi, setFullSyncUi] = useState<{
    open: boolean;
    progress: number | null;
    etaMs: number | null;
    estimateMs: number | null;
    pulled?: number;
    error?: string;
    activity?: string | null;
    history?: Array<{ at: number; text: string }>;
  } | null>(null);
  const fullSyncCloseTimer = useRef<number | null>(null);
  const [releaseWelcomeUi, setReleaseWelcomeUi] = useState<{
    open: boolean;
    content: ReleaseWelcomeContent | null;
    currentVersion: string;
    previousVersion: string | null;
    closing: boolean;
  }>({
    open: false,
    content: null,
    currentVersion: '',
    previousVersion: null,
    closing: false,
  });
  const [authStatus, setAuthStatus] = useState<AuthStatus>({ loggedIn: false, user: null, permissions: null });
  // Меню аккаунта в шапке (Настройки / Смена аккаунта / Выйти) + модалка смены аккаунта.
  const [accountMenuPos, setAccountMenuPos] = useState<{ x: number; y: number } | null>(null);
  const [accountSwitchOpen, setAccountSwitchOpen] = useState(false);
  const [currentUserProfile, setCurrentUserProfile] = useState<CurrentUserProfile | null>(null);
  const [tab, setTabState] = useState<TabId>('history');
  const [postLoginSyncMsg, setPostLoginSyncMsg] = useState<string>('');
  const [historyInitialNoteId, setHistoryInitialNoteId] = useState<string | null>(null);
  const [recentVisits, setRecentVisits] = useState<RecentVisitEntry[]>([]);
  const [quickStartScores, setQuickStartScores] = useState<Record<string, QuickStartScoreEntry>>({});
  const [navigationHistory, setNavigationHistory] = useState<AppNavigationStep[]>([]);
  const [navigationIndex, setNavigationIndex] = useState<number>(-1);
  const lastRecordedVisitSigRef = useRef<string>('');
  const isApplyingHistoryRef = useRef(false);
  const queuedHistoryReplayRef = useRef<{
    step: AppNavigationStep;
    targetIndex: number;
    rollbackIndex: number;
  } | null>(null);
  const prevUserId = useRef<string | null>(null);
  const [authReady, setAuthReady] = useState<boolean>(false);
  const [backupMode, setBackupMode] = useState<{ mode: 'live' | 'backup'; backupDate: string | null } | null>(null);
  const [notesAlertCount, setNotesAlertCount] = useState<number>(0);
  const [historyAlertCount, setHistoryAlertCount] = useState<number>(0);

  const [engines, setEngines] = useState<EngineListItem[]>([]);
  const [selectedEngineId, setSelectedEngineId] = useState<string | null>(null);
  const [engineInitialTab, setEngineInitialTab] = useState<'main' | 'details' | 'files' | 'reclamation'>('main');
  const [engineDetails, setEngineDetails] = useState<EngineDetails | null>(null);
  const [engineLoading, setEngineLoading] = useState<boolean>(false);
  const [engineOpenError, setEngineOpenError] = useState<string>('');
  const [selectedEngineBrandId, setSelectedEngineBrandId] = useState<string | null>(null);
  const [selectedEngineBrandGroupId, setSelectedEngineBrandGroupId] = useState<string | null>(null);

  const [selectedRequestId, setSelectedRequestId] = useState<string | null>(null);
  // Phase 2 (deferred-create): seed for a freshly-created, not-yet-saved supply request (no DB
  // row yet); SupplyRequestDetailsPage materializes it on first save. Cleared on any other open.
  const [newRequestSeed, setNewRequestSeed] = useState<{ id: string; payload: SupplyRequestPayload } | null>(null);
  const [selectedWorkOrderId, setSelectedWorkOrderId] = useState<string | null>(null);
  // Phase 2 (deferred-create): a freshly-created, not-yet-saved work order is opened with its
  // initial payload (chosen kind) instead of a DB row; WorkOrderDetailsPage materializes it on
  // first save. Cleared whenever any other order is opened.
  const [newWorkOrderSeed, setNewWorkOrderSeed] = useState<{ id: string; payload: WorkOrderPayload } | null>(null);
  const [selectedToolId, setSelectedToolId] = useState<string | null>(null);
  const [selectedToolPropertyId, setSelectedToolPropertyId] = useState<string | null>(null);
  const [selectedEmployeeId, setSelectedEmployeeId] = useState<string | null>(null);
  const [selectedTimesheetId, setSelectedTimesheetId] = useState<string | null>(null);
  const [selectedProductId, setSelectedProductId] = useState<string | null>(null);
  const [selectedServiceId, setSelectedServiceId] = useState<string | null>(null);
  /** Откуда открыта карточка услуги: чтобы при закрытии вернуться на исходный список (services / nomenclature / прочее). */
  const [serviceOriginTab, setServiceOriginTab] = useState<TabId | null>(null);
  const [nomenclatureOriginTab, setNomenclatureOriginTab] = useState<TabId | null>(null);
  const [selectedNomenclatureId, setSelectedNomenclatureId] = useState<string | null>(null);
  const [selectedStockDocumentId, setSelectedStockDocumentId] = useState<string | null>(null);
  const [selectedEngineAssemblyBomId, setSelectedEngineAssemblyBomId] = useState<string | null>(null);
  const [stockDocumentParentTab, setStockDocumentParentTab] = useState<StockDocumentParentTab>('stock_documents');
  const [selectedContractId, setSelectedContractId] = useState<string | null>(null);
  const [selectedCounterpartyId, setSelectedCounterpartyId] = useState<string | null>(null);
  const [selectedReportPresetId, setSelectedReportPresetId] = useState<ReportPresetId | null>(null);
  // UI builder: 'new' = создание нового экрана в редакторе (карточный tab требует непустой id).
  const [selectedUserScreenId, setSelectedUserScreenId] = useState<string | null>(null);
  const [userScreenEditMode, setUserScreenEditMode] = useState<boolean>(false);
  const [chatOpen, setChatOpen] = useState<boolean>(true);
  const [globalSearchOpen, setGlobalSearchOpen] = useState<boolean>(false);
  const [chatContext, setChatContext] = useState<{ selectedUserId: string | null; adminMode: boolean }>({
    selectedUserId: null,
    adminMode: false,
  });
  const [chatUnreadTotal, setChatUnreadTotal] = useState<number>(0);
  const chatNewMessageAudioRef = useRef<HTMLAudioElement | null>(null);
  const chatPendingAudioRef = useRef<HTMLAudioElement | null>(null);
  const chatUnreadTotalRef = useRef<number>(0);
  const chatPendingSoundTimerRef = useRef<number | null>(null);
  const [presence, setPresence] = useState<{ online: boolean; lastActivityAt: number | null } | null>(null);
  const [employeesRefreshKey, setEmployeesRefreshKey] = useState<number>(0);
  const [updateStatus, setUpdateStatus] = useState<any>(null);
  const [aiChatOpen, setAiChatOpen] = useState<boolean>(true);
  const aiChatRef = useRef<AiAgentChatHandle | null>(null);
  const [aiLastEvent, setAiLastEvent] = useState<AiAgentEvent | null>(null);
  const [aiRecentEvents, setAiRecentEvents] = useState<AiAgentEvent[]>([]);
  const [uiPrefs, setUiPrefs] = useState<{
    theme: 'auto' | 'light' | 'dark' | 'warm';
    chatSide: 'left' | 'right';
    enterAsTab: boolean;
    displayPrefs: UiDisplayPrefs;
  }>({
    theme: 'auto',
    chatSide: 'right',
    enterAsTab: false,
    displayPrefs: DEFAULT_UI_DISPLAY_PREFS,
  });
  const [effectiveUiControl, setEffectiveUiControl] = useState<UiControlSettings>(DEFAULT_UI_CONTROL_SETTINGS);
  useTabFocusSelectAll({ enableEnterAsTab: uiPrefs.enterAsTab });
  useAutoGrowInputs();
  useAdaptiveListTables();
  const { isMultiColumn, toggle: toggleListColumnsMode } = useListColumnsMode();
  // Планшетный режим (Ф1a): isTabletDevice — «эта машина цеховой планшет» (гейт видимости
  // кнопки, машинно-локально, сеётся эвристикой один раз); isTabletUi — живой touch-layout,
  // что переключает большая кнопка «Комп/Планшет» в шапке.
  const { isTabletDevice } = useTabletDevice();
  const { isTabletUi, toggle: toggleUiMode } = useUiMode();
  const tabletActive = isTabletDevice && isTabletUi;
  const [tabsLayout, setTabsLayout] = useState<TabsLayoutPrefs | null>(null);
  // V2 shell («Резиновый»): per-user выбор оболочки + личные настройки 3-колоночного макета.
  const [shellPrefs, setShellPrefs] = useState<UiShellPrefs | null>(null);
  // V2: какой список открыт во 2-й колонке (null — колонка скрыта). В v1 не используется.
  const [v2ActiveListTab, setV2ActiveListTab] = useState<TabId | null>(null);
  // V2: отложенное открытие карточки после dirty-диалога (замена карточки того же вида).
  const pendingCardOpenRef = useRef<(() => void) | null>(null);
  // V2: replace той же сущности после discard не меняет selectedXId → key совпадает и
  // карточка не ремоунтится (остаётся грязный DOM). Эпоха подмешивается в key карточек
  // и бампается при dirty-замене; в v1 не меняется никогда.
  const [v2CardEpoch, setV2CardEpoch] = useState(0);
  // Фаза 3: вкладки открытых карточек в рабочей области (до 3, single-mount — активна одна,
  // остальные — «закладки» для быстрого возврата). Дедуп по kind+entityId. Не используется в v1.
  const [v2OpenCards, setV2OpenCards] = useState<Array<{ kind: TabId; entityId: string; title: string }>>([]);
  const V2_MAX_OPEN_CARDS = 3;
  // Split «2 рядом»: вторая карточка, смонтированная одновременно с primary (справа).
  // Своё состояние загрузки двигателя (engine — единственная не-self-load карточка) и
  // свой close-actions ref (backstop сохранения работает по обеим панелям).
  const [v2SecondaryCard, setV2SecondaryCard] = useState<{ kind: TabId; entityId: string; title: string } | null>(null);
  const [secondaryEngineDetails, setSecondaryEngineDetails] = useState<EngineDetails | null>(null);
  const [secondaryEngineLoading, setSecondaryEngineLoading] = useState(false);
  const [v2SecondaryEpoch, setV2SecondaryEpoch] = useState(0);
  const secondaryCloseRef = useRef<CardCloseActions | null>(null);
  const [sectionMembership, setSectionMembership] = useState<Partial<Record<string, 'viewer' | 'editor'>> | null>(null);
  useEffect(() => {
    let cancelled = false;
    if (!authStatus.loggedIn) {
      setSectionMembership(null);
      return;
    }
    void window.matrica.access
      .sectionsSelf()
      .then((m) => {
        if (!cancelled) setSectionMembership(m && typeof m === 'object' ? m : null);
      })
      .catch(() => {
        if (!cancelled) setSectionMembership(null);
      });
    // Периодический рефетч: правка membership действующего пользователя (в т.ч. под тем же
    // логином) подхватывается без релогина в пределах ~30с. Пауза при скрытом окне.
    const stop = pollWhenVisible(() => {
      void window.matrica.access
        .sectionsSelf()
        .then((m) => {
          if (!cancelled) setSectionMembership(m && typeof m === 'object' ? m : null);
        })
        .catch(() => {});
    }, 30_000);
    return () => {
      cancelled = true;
      stop();
    };
  }, [authStatus.loggedIn, authStatus.user?.username]);
  const [pinnedShortcuts, setPinnedShortcuts] = useState<string[]>([]);
  /** Сбрасывает применение устаревшего ответа `shortcuts:get`, если за время запроса уже меняли закрепления локально. */
  const shortcutsMutationEpochRef = useRef(0);
  // Workspace-профиль: для какого userId серверный профиль применён (push разрешён) и
  // сигнатура последнего применённого/отправленного снапшота (защита от эхо-записей).
  const uiProfileReadyUserRef = useRef('');
  const uiProfileSigRef = useRef('');
  const [trashOpen, setTrashOpen] = useState(false);
  const trashButtonRef = useRef<HTMLDivElement | null>(null);
  const trashPopupRef = useRef<HTMLDivElement | null>(null);
  const [resolvedTheme, setResolvedTheme] = useState<'light' | 'dark' | 'warm'>('dark');
  const [cardCloseModalOpen, setCardCloseModalOpen] = useState(false);
  const [cardCloseCountdown, setCardCloseCountdown] = useState(10);
  const [cardCloseStatus, setCardCloseStatus] = useState('');
  // Phase 3b: does the closing card support recovery drafts? Drives the third
  // «Оставить черновик» option and the data-safe timeout (keep draft, not force-save).
  const [cardCloseSupportsDraft, setCardCloseSupportsDraft] = useState(false);
  const cardCloseActionsRef = useRef<CardCloseActions | null>(null);
  const cardCloseTargetTabRef = useRef<TabId | null>(null);
  const cardCloseFromAppRef = useRef(false);
  const cardCloseInProgressRef = useRef(false);
  // Split: набор панелей, чьё сохранение решает текущая close-модалка ('primary'/'secondary').
  const cardClosePanesRef = useRef<Array<'primary' | 'secondary'>>([]);
  const [cardClosePaneCount, setCardClosePaneCount] = useState(1);
  const cardCloseTimerRef = useRef<number | null>(null);
  const navigateDeepLinkRef = useRef<(link: ChatDeepLinkPayload) => Promise<void>>(async () => {});
  // Phase 3b: recovery drafts surfaced once after login (null = not shown / dismissed).
  const [recoveryDrafts, setRecoveryDrafts] = useState<
    Array<{ id: string; cardType: string; cardId: string; title: string | null; updatedAt: number }> | null
  >(null);
  const recoveryCheckedUserRef = useRef('');

  const isCardTab = useCallback((nextTab: TabId) => CARD_DETAIL_TABS.includes(nextTab), []);

  const isV2 = authStatus.loggedIn && shellPrefs?.shellVersion === 'v2';

  function clearCardCloseTimer() {
    if (cardCloseTimerRef.current == null) return;
    clearInterval(cardCloseTimerRef.current);
    cardCloseTimerRef.current = null;
  }

  function replayNavigationStep(step: AppNavigationStep) {
    isApplyingHistoryRef.current = true;
    void navigateDeepLinkRef.current(step.link).finally(() => {
      window.setTimeout(() => {
        isApplyingHistoryRef.current = false;
      }, 0);
    });
  }

  function replayQueuedHistoryStep() {
    const queued = queuedHistoryReplayRef.current;
    if (!queued) return false;
    queuedHistoryReplayRef.current = null;
    replayNavigationStep(queued.step);
    return true;
  }

  function clearQueuedHistoryReplay(restoreIndex: boolean) {
    const queued = queuedHistoryReplayRef.current;
    if (!queued) return;
    queuedHistoryReplayRef.current = null;
    if (!restoreIndex) return;
    setNavigationIndex((current) => (current === queued.targetIndex ? queued.rollbackIndex : current));
  }

  const registerCardCloseActions = useCallback((actions: CardCloseActions | null) => {
    cardCloseActionsRef.current = actions;
  }, []);

  const registerSecondaryCardCloseActions = useCallback((actions: CardCloseActions | null) => {
    secondaryCloseRef.current = actions;
  }, []);

  const clearSecondaryPaneState = useCallback(() => {
    secondaryCloseRef.current = null;
    setV2SecondaryCard(null);
    setSecondaryEngineDetails(null);
    setSecondaryEngineLoading(false);
  }, []);

  const paneCloseActions = useCallback(
    (pane: 'primary' | 'secondary') => (pane === 'primary' ? cardCloseActionsRef.current : secondaryCloseRef.current),
    [],
  );

  // Финальный push перед закрытием окна: только что закоммиченные карточки и soft-delete
  // черновиков лежат в реплике как pending — если закрыть окно сразу, они не доедут до
  // сервера, и на другом ПК (или после переустановки) документы всплывут stale-черновиками.
  // Ждём один sync.run с потолком 20с (оффлайн/зависший сервер не должен запирать выход);
  // по таймауту закрываемся — pending дойдёт при следующем запуске, recovery остаётся страховкой.
  const appCloseFinalizingRef = useRef(false);
  const [appCloseSyncing, setAppCloseSyncing] = useState(false);
  const respondAppClose = useCallback(() => {
    if (appCloseFinalizingRef.current) return;
    appCloseFinalizingRef.current = true;
    void (async () => {
      try {
        const s = await window.matrica.auth.status().catch(() => null);
        if (s?.loggedIn) {
          setAppCloseSyncing(true);
          await Promise.race([
            window.matrica.sync.run().catch(() => null),
            new Promise((resolve) => window.setTimeout(resolve, 20000)),
          ]);
        }
      } catch {
        // финальный синк — best-effort, закрытие не блокируем
      }
      window.matrica.app.respondToCloseRequest?.({ allowClose: true });
    })();
  }, []);

  const closeCardSession = useCallback(
    async (opts: { targetTab: TabId | null; appClose: boolean; panes?: Array<'primary' | 'secondary'> }) => {
      if (cardCloseInProgressRef.current && opts.appClose) {
        return;
      }

      const targetTab = opts.targetTab;
      const fromApp = opts.appClose;
      // Какие панели закрываем: явно заданные, иначе — обе при закрытии приложения
      // (проверяем несохранённое в обеих), либо только primary при обычном переходе.
      const panes: Array<'primary' | 'secondary'> =
        opts.panes ??
        (fromApp
          ? (['primary', 'secondary'] as const).filter((p) => paneCloseActions(p) != null)
          : ['primary']);

      const paneDirty = (pane: 'primary' | 'secondary') => {
        const a = paneCloseActions(pane);
        if (!a) return false;
        try {
          return Boolean(a.isDirty());
        } catch {
          return true;
        }
      };
      const dirtyPanes = panes.filter(paneDirty);

      if (dirtyPanes.length === 0) {
        for (const p of panes) {
          const a = paneCloseActions(p);
          if (a) a.closeWithoutSave();
          if (p === 'secondary') clearSecondaryPaneState();
        }
        if (fromApp) {
          respondAppClose();
        } else {
          const pendingOpen = pendingCardOpenRef.current;
          if (pendingOpen) {
            pendingCardOpenRef.current = null;
            pendingOpen();
          } else if (targetTab) {
            setTabState(targetTab);
          }
        }
        return;
      }

      const first = dirtyPanes[0];
      const supportsDraft = dirtyPanes.length === 1 && !!first && Boolean(paneCloseActions(first)?.keepDraft);
      cardCloseInProgressRef.current = true;
      cardCloseTargetTabRef.current = targetTab;
      cardCloseFromAppRef.current = fromApp;
      cardClosePanesRef.current = dirtyPanes;
      clearCardCloseTimer();
      setCardCloseCountdown(10);
      setCardCloseStatus('');
      setCardCloseSupportsDraft(supportsDraft);
      setCardClosePaneCount(dirtyPanes.length);
      setCardCloseModalOpen(true);
      // Автозавершение по таймеру — ТОЛЬКО для карточек с черновиком (безопасный дефолт = оставить
      // черновик: ничего не теряем и ничего молча не коммитим). Legacy-карточки без черновика
      // (напр. карточка двигателя) НЕ дожимаем молча в save — оператор явно выбирает
      // «Сохранить» / «Не сохранять»; иначе он не видит, где набедокурил, а изменения уже записаны.
      if (supportsDraft) {
        cardCloseTimerRef.current = window.setInterval(() => {
          setCardCloseCountdown((seconds) => {
            if (seconds <= 1) {
              clearCardCloseTimer();
              void finalizeCardClose('keepDraft');
              return 0;
            }
            return seconds - 1;
          });
        }, 1000);
      }
    },
    [setTabState, paneCloseActions, clearSecondaryPaneState, respondAppClose],
  );

  const finalizeCardClose = useCallback(
    async (decision: 'save' | 'discard' | 'keepDraft') => {
      clearCardCloseTimer();
      setCardCloseModalOpen(false);
      cardCloseInProgressRef.current = false;

      const panes = cardClosePanesRef.current;
      cardClosePanesRef.current = [];
      const targetTab = cardCloseTargetTabRef.current;
      const fromApp = cardCloseFromAppRef.current;
      cardCloseTargetTabRef.current = null;
      cardCloseFromAppRef.current = false;

      if (panes.length === 0) {
        if (fromApp) respondAppClose();
        return;
      }

      try {
        // Решение применяется ко всем грязным панелям (при закрытии приложения их может быть две).
        for (const p of panes) {
          const actions = paneCloseActions(p);
          if (!actions) continue;
          if (decision === 'save') {
            await actions.saveAndClose();
          } else if (decision === 'keepDraft') {
            // Keep the unsaved snapshot as a recovery draft; fall back to commit only if
            // the card has no draft support (so we never silently discard on this path).
            if (actions.keepDraft) await actions.keepDraft();
            else await actions.saveAndClose();
          } else {
            actions.closeWithoutSave();
          }
          if (p === 'secondary') clearSecondaryPaneState();
        }
      } catch (e) {
        setCardCloseStatus(`Ошибка сохранения: ${String(e)}`);
        cardCloseInProgressRef.current = false;
        pendingCardOpenRef.current = null;
        clearQueuedHistoryReplay(true);
        return;
      }

      // V2: карточка закрыта ради открытия другой (замена того же вида) — выполняем
      // отложенное открытие вместо переключения таба.
      const pendingOpen = pendingCardOpenRef.current;
      if (pendingOpen) {
        pendingCardOpenRef.current = null;
        pendingOpen();
        if (fromApp) {
          respondAppClose();
        }
        return;
      }

      if (replayQueuedHistoryStep()) {
        if (fromApp) {
          respondAppClose();
        }
        return;
      }

      if (targetTab) {
        setTabState(targetTab);
      }

      if (fromApp) {
        respondAppClose();
      }
    },
    [setTabState, paneCloseActions, clearSecondaryPaneState, respondAppClose],
  );

  const requestTabSwitch = useCallback(
    (nextTab: TabId) => {
      if (nextTab === tab) return;
      if (isCardTab(tab)) {
        void closeCardSession({ targetTab: nextTab, appClose: false });
        return;
      }
      setTabState(nextTab);
    },
    [isCardTab, tab, closeCardSession, setTabState],
  );

  const setTab = useCallback((nextTab: TabId) => {
    // V2: кнопка-список раскрывает колонку списков, не трогая рабочую область
    // (открытую карточку/страницу). Обычный переход — только когда фокус уже на списке.
    if (isV2 && V2_LIST_TABS.has(nextTab) && nextTab !== tab && !V2_LIST_TABS.has(tab)) {
      // V2: списки живут в колонке и не меняют tab — визит логируем здесь же (задача E).
      logUiUsage('ui.visit', nextTab);
      setV2ActiveListTab(nextTab);
      return;
    }
    requestTabSwitch(nextTab);
  }, [requestTabSwitch, isV2, tab]);

  // V2: список виден рядом с открытой карточкой, поэтому клик по другой строке того же
  // списка меняет selectedXId БЕЗ смены таба — requestTabSwitch не сработает, и key-ремоунт
  // молча потерял бы несохранённые правки. Гейтим замену карточки тем же dirty-диалогом;
  // отложенное открытие выполняет finalizeCardClose.
  // Телеметрия навигации (задача E): визит вкладки в синкающийся audit_log —
  // еженедельная AI-рутина агрегирует это в дайджест суперадмину.
  useEffect(() => {
    if (!authStatus.loggedIn) return;
    logUiUsage('ui.visit', tab);
  }, [tab, authStatus.loggedIn]);

  const v2OpenCardGuarded = useCallback(
    (kind: TabId, run: () => void) => {
      logUiUsage('ui.card_open', kind);
      if (!isV2 || tab !== kind) {
        run();
        return;
      }
      const actions = cardCloseActionsRef.current;
      let dirty = false;
      if (actions) {
        try {
          dirty = Boolean(actions.isDirty());
        } catch {
          dirty = true;
        }
      }
      if (!dirty) {
        run();
        return;
      }
      pendingCardOpenRef.current = () => {
        setV2CardEpoch((e) => e + 1);
        run();
      };
      void closeCardSession({ targetTab: null, appClose: false });
    },
    [isV2, tab, closeCardSession],
  );

  // V2: фокус на списке — синхронизируем колонку списков (в т.ч. возврат из карточки
  // на родительский список и первый вход в v2 на списочном табе).
  useEffect(() => {
    if (!isV2) return;
    if (V2_LIST_TABS.has(tab)) setV2ActiveListTab(tab);
  }, [isV2, tab]);

  // V2: «Закрыть карточку» закрывает и её вкладку (инвариант: любой путь, снимающий карточку
  // с рабочей области, удаляет её дескриптор из v2OpenCards — иначе зависшая вкладка переоткрывает
  // устаревшее состояние карточки). closeV2Card содержит dirty-guard и выбор следующего фокуса.
  function requestCardClose() {
    if (isV2) {
      const idn = v2CurrentCardIdentity();
      if (idn) {
        closeV2Card(idn);
        return;
      }
    }
    const parentTab = CARD_PARENT_TAB[tab];
    if (parentTab) {
      void closeCardSession({ targetTab: parentTab, appClose: false });
    }
  }

  const applyEffectiveUiSettings = useCallback((settings: UiControlSettings) => {
    setEffectiveUiControl(sanitizeUiControlSettings(settings));
  }, []);

  useEffect(() => {
    const safe = withUiControlPresetApplied(effectiveUiControl, sanitizeUiPresetId(effectiveUiControl.presets.defaultPresetId ?? DEFAULT_UI_PRESET_ID, DEFAULT_UI_PRESET_ID));
    const displayPrefs = uiControlToDisplayPrefs(safe);
    setUiPrefs((prev) => ({ ...prev, displayPrefs }));
    const root = document.documentElement;
    root.style.setProperty('--ui-title-size', `${safe.global.titleFontSize}px`);
    root.style.setProperty('--ui-section-size', `${safe.global.sectionFontSize}px`);
    root.style.setProperty('--ui-body-size', `${safe.global.bodyFontSize}px`);
    root.style.setProperty('--ui-muted-size', `${safe.global.mutedFontSize}px`);
    root.style.setProperty('--ui-space-1', `${safe.global.space1}px`);
    root.style.setProperty('--ui-space-2', `${safe.global.space2}px`);
    root.style.setProperty('--ui-space-3', `${safe.global.space3}px`);
    root.style.setProperty('--ui-space-4', `${safe.global.space4}px`);
    root.style.setProperty('--ui-space-5', `${safe.global.space5}px`);
    root.style.setProperty('--ui-list-font-size', `${safe.lists.fontSize}px`);
    root.style.setProperty('--ui-list-text-max-ch', String(safe.lists.textColumnMaxCh));
    root.style.setProperty('--ui-list-auto-columns-enabled', safe.lists.autoColumnsEnabled ? '1' : '0');
    root.style.setProperty('--ui-list-auto-columns-max', String(Math.max(1, Math.min(3, Math.round(safe.lists.autoColumnsMax)))));
    root.style.setProperty('--ui-list-auto-columns-gap-px', `${Math.max(0, Math.round(safe.lists.autoColumnsGapPx))}`);
    root.style.setProperty('--ui-card-font-size', `${safe.cards.fontSize}px`);
    root.style.setProperty('--list-row-padding-y', `${safe.lists.rowPaddingY}px`);
    root.style.setProperty('--list-row-padding-x', `${safe.lists.rowPaddingX}px`);
    root.style.setProperty('--card-row-gap', `${safe.cards.rowGap}px`);
    root.style.setProperty('--card-row-padding-y', `${safe.cards.rowPaddingY}px`);
    root.style.setProperty('--card-row-padding-x', `${safe.cards.rowPaddingX}px`);
    const sectionAltStrength = Math.max(0, Math.min(30, Math.round(Number(safe.cards.sectionAltStrength ?? 0))));
    const sectionAltOdd = safe.cards.sectionAltBackgrounds ? Math.max(0, Math.floor(sectionAltStrength / 2)) : 0;
    const sectionAltEven = safe.cards.sectionAltBackgrounds ? sectionAltStrength : 0;
    root.style.setProperty('--ui-section-card-alt-odd', `${sectionAltOdd}%`);
    root.style.setProperty('--ui-section-card-alt-even', `${sectionAltEven}%`);
    root.style.setProperty('--ui-table-size', `${safe.directories.tableFontSize}px`);
    root.style.setProperty('--entity-card-min-width', `${safe.directories.entityCardMinWidth}px`);
    root.style.setProperty('--ui-content-max-width', `${safe.layout.contentMaxWidth}px`);
    root.style.setProperty('--ui-content-block-min-width', `${safe.layout.blockMinWidth}px`);
    root.style.setProperty('--ui-content-block-max-width', `${safe.layout.blockMaxWidth}px`);
    root.style.setProperty('--ui-datepicker-scale', String(safe.misc.datePickerScale));
    root.style.setProperty('--ui-datepicker-font-size', `${safe.misc.datePickerFontSize}px`);
    root.style.setProperty('--ui-input-autogrow-min-ch', String(safe.inputs.autoGrowMinChars));
    root.style.setProperty('--ui-input-autogrow-max-ch', String(safe.inputs.autoGrowMaxChars));
    root.style.setProperty('--ui-input-autogrow-extra-ch', String(safe.inputs.autoGrowExtraChars));
    root.dataset.uiInputAutogrowAll = safe.inputs.autoGrowAllFields ? '1' : '0';
  }, [effectiveUiControl]);

  // Signature over the row's DISPLAYED fields, not just the engine entity's own
  // updatedAt. Контрагент/контракт (customerName/contractName), dates, scrap flag
  // and attachment previews are denormalized — derived from related attributes /
  // the contract — and change WITHOUT bumping the engine's updatedAt (e.g. when an
  // engine is attached to a contract from the contract card). A guard keyed only on
  // updatedAt/syncStatus treats such rows as unchanged and discards a correctly
  // refetched list, so the list keeps showing stale контрагент/contract.
  function engineRowSignature(e: EngineListItem): string {
    return [
      e.id,
      e.updatedAt ?? 0,
      e.syncStatus ?? '',
      e.engineNumber ?? '',
      e.internalNumber ?? '',
      e.internalNumberYear ?? '',
      e.engineBrand ?? '',
      e.customerName ?? '',
      e.contractName ?? '',
      e.arrivalDate ?? '',
      e.shippingDate ?? '',
      e.isScrap ? 1 : 0,
      (e.attachmentPreviews ?? []).map((p) => p.id).join(','),
    ].join('|');
  }

  function sameEngineList(a: EngineListItem[], b: EngineListItem[]) {
    if (a === b) return true;
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      const left = a[i];
      const right = b[i];
      if (!left || !right) return false;
      if (engineRowSignature(left) !== engineRowSignature(right)) return false;
    }
    return true;
  }

  function sameEngineDetails(a: EngineDetails | null, b: EngineDetails | null) {
    if (a === b) return true;
    if (!a || !b) return false;
    return (
      a.id === b.id &&
      a.typeId === b.typeId &&
      Number(a.updatedAt ?? 0) === Number(b.updatedAt ?? 0) &&
      Number(a.createdAt ?? 0) === Number(b.createdAt ?? 0) &&
      Number(a.deletedAt ?? 0) === Number(b.deletedAt ?? 0) &&
      String(a.syncStatus ?? '') === String(b.syncStatus ?? '')
    );
  }

  useEffect(() => {
    void refreshEngines();
    void window.matrica.auth
      .status()
      .then((s) => {
        setAuthStatus(s);
        prevUserId.current = s.loggedIn ? s.user?.id ?? null : null;
        if (s.loggedIn) {
          void window.matrica.auth.sync().then((next) => setAuthStatus(next)).catch(() => {});
        }
      })
      .catch(() => {})
      .finally(() => setAuthReady(true));
    void window.matrica.settings.uiGet().then((r: any) => {
      if (r?.ok) {
        setUiPrefs((prev) => ({
          ...prev,
          theme: r.theme ?? 'auto',
          chatSide: r.chatSide ?? 'right',
          enterAsTab: r.enterAsTab === true,
        }));
      }
    });
    void window.matrica.settings.uiControlGet().then((r: any) => {
      if (r?.ok && r?.effective) applyEffectiveUiSettings(r.effective as UiControlSettings);
    });
  }, [applyEffectiveUiSettings]);

  useEffect(() => {
    let alive = true;
    void window.matrica.settings
      .releaseWelcomeGet()
      .then((r) => {
        if (!alive) return;
        if (!r?.ok || r.shouldShow !== true || !r.welcome) return;
        setReleaseWelcomeUi({
          open: true,
          content: r.welcome,
          currentVersion: String(r.currentVersion ?? ''),
          previousVersion: r.previouslySeenVersion ? String(r.previouslySeenVersion) : null,
          closing: false,
        });
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!authStatus.loggedIn) return;
    void window.matrica.settings.uiControlGet().then((r: any) => {
      if (r?.ok && r?.effective) applyEffectiveUiSettings(r.effective as UiControlSettings);
    });
  }, [applyEffectiveUiSettings, authStatus.loggedIn, authStatus.user?.id]);

  useEffect(() => {
    if (!window.matrica?.sync?.onProgress) return;
    const unsubscribe = window.matrica.sync.onProgress((evt: SyncProgressEvent) => {
      if (!evt) return;
      if (evt.mode === 'incremental') {
        const activity = formatSyncActivity(evt);
        if (incrementalSyncCloseTimer.current) {
          window.clearTimeout(incrementalSyncCloseTimer.current);
          incrementalSyncCloseTimer.current = null;
        }
        if (evt.state === 'start') {
          setIncrementalSyncUi({ active: true, progress: evt.progress ?? null, activity, error: null });
          return;
        }
        if (evt.state === 'progress') {
          // Progressive fill: EAV-ядро + ERP применены — показываем данные, не дожидаясь хвоста.
          if (evt.coreReady) {
            void refreshEngines();
            if (tab === 'engine') void reloadEngine();
          }
          setIncrementalSyncUi((prev) => ({
            active: true,
            progress: evt.progress ?? prev?.progress ?? null,
            activity: activity ?? prev?.activity ?? null,
            error: null,
          }));
          return;
        }
        if (evt.state === 'done') {
          if (Number(evt.pulled ?? 0) > 0) {
            void refreshEngines();
            if (tab === 'engine') void reloadEngine();
          }
          setIncrementalSyncUi((prev) => ({
            active: false,
            progress: 1,
            activity: activity ?? prev?.activity ?? 'Синхронизация завершена',
            error: null,
          }));
          incrementalSyncCloseTimer.current = window.setTimeout(() => setIncrementalSyncUi(null), 2200);
          return;
        }
        if (evt.state === 'error') {
          setIncrementalSyncUi((prev) => ({
            active: false,
            progress: prev?.progress ?? null,
            activity: activity ?? prev?.activity ?? 'Ошибка синхронизации',
            error: evt.error ?? 'unknown',
          }));
          incrementalSyncCloseTimer.current = window.setTimeout(() => setIncrementalSyncUi(null), 5000);
          return;
        }
        return;
      }
      if (evt.mode !== 'force_full_pull') return;
      const activity = formatSyncActivity(evt);
      if (fullSyncCloseTimer.current) {
        window.clearTimeout(fullSyncCloseTimer.current);
        fullSyncCloseTimer.current = null;
      }
      if (evt.state === 'start') {
        setFullSyncUi({
          open: true,
          progress: evt.progress ?? 0,
          etaMs: evt.etaMs ?? null,
          estimateMs: evt.estimateMs ?? null,
          activity,
          history: activity ? pushSyncHistory([], activity) : [],
        });
        return;
      }
      if (evt.state === 'progress') {
        setFullSyncUi((prev) => ({
          open: true,
          progress: evt.progress ?? prev?.progress ?? 0,
          etaMs: evt.etaMs ?? prev?.etaMs ?? null,
          estimateMs: evt.estimateMs ?? prev?.estimateMs ?? null,
          ...(evt.pulled != null ? { pulled: evt.pulled } : prev?.pulled != null ? { pulled: prev.pulled } : {}),
          activity: activity ?? prev?.activity ?? null,
          history: activity ? pushSyncHistory(prev?.history ?? [], activity) : prev?.history ?? [],
        }));
        return;
      }
      if (evt.state === 'done') {
        if (Number(evt.pulled ?? 0) > 0) {
          void refreshEngines();
          if (tab === 'engine') void reloadEngine();
        }
        setFullSyncUi((prev) => ({
          open: true,
          progress: 1,
          etaMs: 0,
          estimateMs: evt.estimateMs ?? prev?.estimateMs ?? null,
          ...(evt.pulled != null ? { pulled: evt.pulled } : prev?.pulled != null ? { pulled: prev.pulled } : {}),
          activity: activity ?? prev?.activity ?? null,
          history: activity ? pushSyncHistory(prev?.history ?? [], activity) : prev?.history ?? [],
        }));
        fullSyncCloseTimer.current = window.setTimeout(() => setFullSyncUi(null), 1500);
        return;
      }
      if (evt.state === 'error') {
        setFullSyncUi((prev) => ({
          open: true,
          progress: prev?.progress ?? null,
          etaMs: null,
          estimateMs: evt.estimateMs ?? prev?.estimateMs ?? null,
          ...(prev?.pulled != null ? { pulled: prev.pulled } : {}),
          error: evt.error ?? 'unknown',
          activity: activity ?? prev?.activity ?? null,
          history: activity ? pushSyncHistory(prev?.history ?? [], activity) : prev?.history ?? [],
        }));
      }
    });
    return () => {
      if (incrementalSyncCloseTimer.current) window.clearTimeout(incrementalSyncCloseTimer.current);
      incrementalSyncCloseTimer.current = null;
      if (fullSyncCloseTimer.current) window.clearTimeout(fullSyncCloseTimer.current);
      fullSyncCloseTimer.current = null;
      if (unsubscribe) unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!window.matrica?.app?.onCloseRequest) return;
    const unsubscribe = window.matrica.app.onCloseRequest(() => {
      void closeCardSession({ targetTab: null, appClose: true });
    });
    return () => {
      if (typeof unsubscribe === 'function') unsubscribe();
    };
  }, [closeCardSession]);

  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      // Split: карточка может быть в primary-табе И/ИЛИ в secondary-панели.
      if (!isCardTab(tab) && !v2SecondaryCard) return;
      const paneDirty = (a: CardCloseActions | null) => {
        if (!a) return false;
        try {
          return Boolean(a.isDirty());
        } catch {
          return true;
        }
      };
      const dirty = paneDirty(cardCloseActionsRef.current) || paneDirty(secondaryCloseRef.current);
      if (!dirty) {
        respondAppClose();
        return;
      }

      event.preventDefault();
      event.returnValue = 'Карточка закрывается. Сохранить изменения в карточке?';
      void closeCardSession({ targetTab: null, appClose: true });
    };

    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
    };
  }, [closeCardSession, isCardTab, tab, v2SecondaryCard, respondAppClose]);

  useEffect(() => {
    const userId = authStatus.loggedIn ? authStatus.user?.id ?? '' : '';
    if (!userId) {
      setTabsLayout(null);
      setShellPrefs(null);
      setV2ActiveListTab(null);
      setPinnedShortcuts([]);
      shortcutsMutationEpochRef.current = 0;
      return;
    }
    let alive = true;
    const epochAtFetchStart = shortcutsMutationEpochRef.current;
    void window.matrica.settings
      .uiGet({ userId })
      .then((r: any) => {
        if (!alive) return;
        if (r?.ok) {
          setTabsLayout((r.tabsLayout as TabsLayoutPrefs | null) ?? null);
          // Нет сохранённой записи → дефолт («Резиновый», v2). Явный выбор оператора
          // (в т.ч. возврат на старый) хранится в записи и переживает обновления.
          setShellPrefs(sanitizeUiShellPrefs(r.shellPrefs ?? null));
        }
      })
      .catch(() => {});
    void window.matrica.shortcuts
      .get({ userId })
      .then((r) => {
        if (!alive) return;
        if (epochAtFetchStart !== shortcutsMutationEpochRef.current) return;
        if (r?.ok) {
          const raw = r.ids as unknown;
          const ids = Array.isArray(raw)
            ? raw.map((x) => String(x).trim()).filter((s) => s.length > 0)
            : typeof raw === 'string' && raw.trim()
              ? [raw.trim()]
              : [];
          setPinnedShortcuts(ids);
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [authStatus.loggedIn, authStatus.user?.id]);

  // Серверный workspace-профиль (вкладки/ярлыки/Мой Круг): применяем при логине поверх
  // локальных значений, затем debounced-push изменений (см. эффект ниже).
  useEffect(() => {
    const userId = authStatus.loggedIn ? String(authStatus.user?.id ?? '').trim() : '';
    if (!userId) {
      uiProfileReadyUserRef.current = '';
      uiProfileSigRef.current = '';
      return;
    }
    let alive = true;
    // Posev default-кнопки «Табель» в «Мой круг» — один раз на клиента, ПОСЛЕ авторитетной
    // загрузки пинов с сервера (иначе серверный набор перетёр бы добавку). Дальше клиент
    // волен убрать плитку — флаг не даст подсеять повторно.
    const seedTimesheetShortcut = () => {
      try {
        if (window.localStorage.getItem(timesheetShortcutSeededKey(userId)) === '1') return;
        setPinnedShortcuts((prev) => (prev.includes(TIMESHEET_SHORTCUT_ID) ? prev : [...prev, TIMESHEET_SHORTCUT_ID]));
        window.localStorage.setItem(timesheetShortcutSeededKey(userId), '1');
      } catch {
        /* localStorage недоступен — пропускаем посев */
      }
    };
    void window.matrica.auth
      .uiProfileGet()
      .then((r) => {
        if (!alive) return;
        if (!r?.ok) {
          // Офлайн/ошибка: работаем на локальных значениях, push включаем — изменения доедут.
          seedTimesheetShortcut();
          uiProfileReadyUserRef.current = userId;
          return;
        }
        const p = r.profile;
        if (p) {
          if (p.tabsLayout !== undefined) {
            setTabsLayout((p.tabsLayout as TabsLayoutPrefs | null) ?? null);
            void window.matrica.settings.uiSet({ userId, tabsLayout: (p.tabsLayout as TabsLayoutPrefs | null) ?? null }).catch(() => {});
          }
          if (Array.isArray(p.shortcuts)) {
            shortcutsMutationEpochRef.current += 1;
            setPinnedShortcuts(p.shortcuts);
            void window.matrica.shortcuts.set({ userId, ids: p.shortcuts }).catch(() => {});
          }
          if (Array.isArray(p.recentVisits)) {
            setRecentVisits(parseRecentVisits(JSON.stringify(p.recentVisits)));
          }
          if (p.quickStartScores) {
            setQuickStartScores(normalizeQuickStartScores(p.quickStartScores));
          }
          uiProfileSigRef.current = JSON.stringify({
            tabsLayout: p.tabsLayout ?? null,
            shortcuts: p.shortcuts ?? [],
            recentVisits: p.recentVisits ?? [],
            quickStartScores: p.quickStartScores ?? {},
          });
        }
        seedTimesheetShortcut();
        uiProfileReadyUserRef.current = userId;
      })
      .catch(() => {
        uiProfileReadyUserRef.current = userId;
      });
    return () => {
      alive = false;
    };
  }, [authStatus.loggedIn, authStatus.user?.id]);

  // Push workspace-профиля на сервер: дебаунс против шторма записей, сигнатура против эха
  // только что применённого серверного профиля.
  useEffect(() => {
    const userId = authStatus.loggedIn ? String(authStatus.user?.id ?? '').trim() : '';
    if (!userId || uiProfileReadyUserRef.current !== userId) return;
    const snapshot = {
      tabsLayout: tabsLayout ?? null,
      shortcuts: pinnedShortcuts,
      recentVisits: recentVisits.slice(0, RECENT_VISITS_LIMIT),
      quickStartScores: normalizeQuickStartScores(quickStartScores),
    };
    const sig = JSON.stringify(snapshot);
    if (sig === uiProfileSigRef.current) return;
    const timer = window.setTimeout(() => {
      uiProfileSigRef.current = sig;
      void window.matrica.auth
        .uiProfileSet({ profile: { ...snapshot, updatedAt: Date.now() } })
        .then((r) => {
          // stale: на другой машине профиль свежее — не перетираем, подхватим при следующем логине.
          if (r?.ok && r.stale) uiProfileSigRef.current = '';
        })
        .catch(() => {});
    }, 1500);
    return () => window.clearTimeout(timer);
  }, [authStatus.loggedIn, authStatus.user?.id, tabsLayout, pinnedShortcuts, recentVisits, quickStartScores]);

  useEffect(() => {
    const userId = authStatus.loggedIn ? String(authStatus.user?.id ?? '').trim() : '';
    if (!userId) {
      setRecentVisits([]);
      setQuickStartScores({});
      lastRecordedVisitSigRef.current = '';
      return;
    }
    try {
      const key = recentVisitsStorageKey(userId);
      setRecentVisits(parseRecentVisits(window.localStorage.getItem(key)));
    } catch {
      setRecentVisits([]);
    }
    try {
      const key = quickStartRatingsStorageKey(userId);
      const raw = window.localStorage.getItem(key);
      if (!raw) {
        setQuickStartScores({});
      } else {
        const parsed = JSON.parse(raw) as unknown;
        setQuickStartScores(normalizeQuickStartScores(parsed));
      }
    } catch {
      setQuickStartScores({});
    }
    lastRecordedVisitSigRef.current = '';
  }, [authStatus.loggedIn, authStatus.user?.id]);

  useEffect(() => {
    const userId = authStatus.loggedIn ? String(authStatus.user?.id ?? '').trim() : '';
    if (!userId) return;
    try {
      const key = recentVisitsStorageKey(userId);
      window.localStorage.setItem(key, JSON.stringify(recentVisits.slice(0, RECENT_VISITS_LIMIT)));
    } catch {
      // ignore localStorage issues
    }
  }, [authStatus.loggedIn, authStatus.user?.id, recentVisits]);

  useEffect(() => {
    const userId = authStatus.loggedIn ? String(authStatus.user?.id ?? '').trim() : '';
    if (!userId) return;
    try {
      const key = quickStartRatingsStorageKey(userId);
      window.localStorage.setItem(key, JSON.stringify(normalizeQuickStartScores(quickStartScores)));
    } catch {
      // ignore localStorage issues
    }
  }, [authStatus.loggedIn, authStatus.user?.id, quickStartScores]);

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const r = await window.matrica.backups.status();
        if (!alive) return;
        if (r && (r as any).ok === true) {
          setBackupMode({ mode: (r as any).mode, backupDate: (r as any).backupDate ?? null });
        }
      } catch {
        // ignore
      }
    };
    void poll();
    // Локальный IPC (не прод), но скрытому окну индикатор режима бэкапа не нужен — пауза.
    const stop = pollWhenVisible(() => void poll(), 15_000);
    return () => {
      alive = false;
      stop();
    };
  }, []);

  // When switching live <-> backup mode, reload lists from the current DB.
  useEffect(() => {
    if (!backupMode) return;
    void refreshEngines();
    // Reset opened details when data source changes.
    setSelectedEngineId(null);
    setEngineDetails(null);
    setSelectedContractId(null);
    setSelectedRequestId(null);
    setSelectedWorkOrderId(null);
    setSelectedEngineBrandId(null);
    setSelectedEngineBrandGroupId(null);
    setSelectedEmployeeId(null);
    setSelectedProductId(null);
    setSelectedServiceId(null);
    setServiceOriginTab(null);
    setNomenclatureOriginTab(null);
    setSelectedCounterpartyId(null);
    setSelectedReportPresetId(null);
  }, [backupMode?.mode, backupMode?.backupDate]);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const r = await window.matrica.update.status();
        if (!alive) return;
        if (r && (r as any).ok) setUpdateStatus((r as any).status ?? null);
      } catch {
        // ignore
      }
    };
    void tick();
    // Статус апдейтера — визуальный бейдж; скрытому окну не нужен — пауза.
    const stop = pollWhenVisible(() => void tick(), 30_000);
    return () => {
      alive = false;
      stop();
    };
  }, []);

  async function runSyncNow() {
    try {
      if (backupMode?.mode === 'backup') {
        return;
      }
      const r = await window.matrica.sync.run();
      if (r.ok) {
        await refreshEngines();
      }
    } catch {
      // ignore sync request errors during periodic background run
    }
  }

  function resetUserScopedState() {
    setEngines([]);
    setEngineDetails(null);
    setSelectedEngineId(null);
    setSelectedEngineBrandId(null);
    setSelectedEngineBrandGroupId(null);
    setSelectedContractId(null);
    setSelectedRequestId(null);
    setSelectedWorkOrderId(null);
    setSelectedEmployeeId(null);
    setSelectedProductId(null);
    setSelectedServiceId(null);
    setServiceOriginTab(null);
    setNomenclatureOriginTab(null);
    setSelectedCounterpartyId(null);
    setSelectedReportPresetId(null);
    setChatUnreadTotal(0);
    setChatContext({ selectedUserId: null, adminMode: false });
    setPresence(null);
    setHistoryInitialNoteId(null);
    setRecentVisits([]);
    setNavigationHistory([]);
    setNavigationIndex(-1);
    lastRecordedVisitSigRef.current = '';
    isApplyingHistoryRef.current = false;
    queuedHistoryReplayRef.current = null;
    setV2ActiveListTab(null);
    setV2OpenCards([]);
    setV2SecondaryCard(null);
    setSecondaryEngineDetails(null);
    setSecondaryEngineLoading(false);
    secondaryCloseRef.current = null;
    pendingCardOpenRef.current = null;
    setEmployeesRefreshKey((k) => k + 1);
    setAiChatOpen(true);
  }

  // When user changes (logout or login as another user), reset state and sync.
  useEffect(() => {
    if (!authReady) return;
    const currentId = authStatus.loggedIn ? authStatus.user?.id ?? null : null;
    const prevId = prevUserId.current;
    if (prevId === currentId) return;
    prevUserId.current = currentId;
    resetUserScopedState();
      if (!currentId) return;
    if (backupMode?.mode === 'backup') return;
    void (async () => {
      await runSyncNow();
    })();
  }, [authReady, authStatus.loggedIn, authStatus.user?.id, backupMode?.mode]);

  // Periodically sync auth permissions from server (important for delegated permissions).
  useEffect(() => {
    if (!authStatus.loggedIn) return;
    let alive = true;
    const poll = async () => {
      try {
        const s = await window.matrica.auth.sync();
        if (!alive) return;
        setAuthStatus(s);
      } catch {
        // ignore
      }
    };
    // Подхват делегированных прав (`/auth/me`): ≤60с достаточно, чаще — лишний прод-трафик × клиент.
    // Пауза при скрытом окне + refresh при возврате фокуса.
    const stop = pollWhenVisible(() => void poll(), 60_000);
    return () => {
      alive = false;
      stop();
    };
  }, [authStatus.loggedIn]);

  useEffect(() => {
    const userId = authStatus.loggedIn ? String(authStatus.user?.id ?? '').trim() : '';
    if (!userId) {
      setCurrentUserProfile(null);
      return;
    }
    let alive = true;
    void window.matrica.auth
      .profileGet()
      .then((result: any) => {
        if (!alive) return;
        const profile = result?.ok ? result.profile : null;
        if (!profile) {
          setCurrentUserProfile(null);
          return;
        }
        setCurrentUserProfile({
          fullName: String(profile.fullName ?? '').trim(),
          position: String(profile.position ?? '').trim(),
          sectionId: profile.sectionId ? String(profile.sectionId) : null,
          sectionName: profile.sectionName ? String(profile.sectionName) : null,
        });
      })
      .catch(() => {
        if (!alive) return;
        setCurrentUserProfile(null);
      });
    return () => {
      alive = false;
    };
  }, [authStatus.loggedIn, authStatus.user?.id]);

  useEffect(() => {
    const mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
    const pick = (): 'light' | 'dark' | 'warm' => {
      if (uiPrefs.theme === 'light') return 'light';
      if (uiPrefs.theme === 'dark') return 'dark';
      if (uiPrefs.theme === 'warm') return 'warm';
      return mq?.matches ? 'dark' : 'light';
    };
    setResolvedTheme(pick());
    if (!mq) return;
    const handler = () => setResolvedTheme(pick());
    mq.addEventListener?.('change', handler);
    return () => mq.removeEventListener?.('change', handler);
  }, [uiPrefs.theme]);

  useEffect(() => {
    try {
      document.documentElement.dataset.theme = resolvedTheme;
    } catch {
      // ignore
    }
  }, [resolvedTheme]);

  // Планшетный режим → data-ui-mode на :root; CSS-блок [data-ui-mode='tablet'] в global.css
  // поднимает хит-таргеты/шрифты/паддинги. На не-планшете (или при выборе «Комп») — 'comp'.
  useEffect(() => {
    try {
      document.documentElement.dataset.uiMode = tabletActive ? 'tablet' : 'comp';
    } catch {
      // ignore
    }
  }, [tabletActive]);

  useEffect(() => {
    const root = document.documentElement;
    const TABLET_MIN_FONT = 17;
    let listSize = Math.max(10, Math.min(48, Number(uiPrefs.displayPrefs?.listFontSize ?? DEFAULT_UI_DISPLAY_PREFS.listFontSize)));
    let cardSize = Math.max(10, Math.min(48, Number(uiPrefs.displayPrefs?.cardFontSize ?? DEFAULT_UI_DISPLAY_PREFS.cardFontSize)));
    // Списочный/карточный шрифт задаётся ЭТИМ инлайн-каналом (инлайн > CSS-правило темы),
    // поэтому планшет-минимум подмешиваем здесь же, а не в CSS-блоке. Больший пользовательский
    // размер уважаем (Math.max) — лишь поднимаем мелкий до планшетного минимума.
    if (tabletActive) {
      listSize = Math.max(listSize, TABLET_MIN_FONT);
      cardSize = Math.max(cardSize, TABLET_MIN_FONT);
    }
    root.style.setProperty('--ui-list-font-size', `${listSize}px`);
    root.style.setProperty('--ui-card-font-size', `${cardSize}px`);
  }, [uiPrefs.displayPrefs, tabletActive]);

  useEffect(() => {
    if (!authStatus.loggedIn) {
      setPresence(null);
      return;
    }
    let alive = true;
    const poll = async () => {
      const r = await window.matrica.presence.me().catch(() => null);
      if (!alive) return;
      if (r && (r as any).ok) {
        setPresence({ online: !!(r as any).online, lastActivityAt: (r as any).lastActivityAt ?? null });
      }
    };
    void poll();
    // Собственный индикатор «в сети»: 60с достаточно, чаще — лишний прод-трафик
    // (`/presence/me` × каждый клиент). См. инцидент CPU/presence (GOTCHAS M28).
    const id = setInterval(() => void poll(), 60_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [authStatus.loggedIn]);

  const capsRaw = deriveUiCaps(authStatus.permissions ?? null);
  const userRole = String(authStatus.user?.role ?? '').trim().toLowerCase();
  const roleCanForceMasterdataEdit = (userRole === 'admin' || userRole === 'superadmin') && capsRaw.canViewMasterData;
  const capsBase =
    roleCanForceMasterdataEdit && !capsRaw.canEditMasterData
      ? { ...capsRaw, canEditMasterData: true }
      : capsRaw;
  const viewMode = backupMode?.mode === 'backup';
  const canChat = !!authStatus.permissions?.['chat.use'];
  const canChatExport = !!authStatus.permissions?.['chat.export'];
  const canChatAdminView = !!authStatus.permissions?.['chat.admin.view'];
  // Асинхронный AI-чат (очередь + облачная рутина) не зависит от серверного
  // AI_ENABLED (флаг старого синхронного Anthropic-контура) — только chat.use.
  const canAiAgent = authStatus.loggedIn && canChat;
  const caps = viewMode
    ? {
        ...capsBase,
        canUseSync: false,
        canUseUpdates: false,
        canEditEngines: false,
        canEditTimesheets: false,
        canEditOperations: false,
        canCreateSupplyRequests: false,
        canEditSupplyRequests: false,
        canCreateWorkOrders: false,
        canEditWorkOrders: false,
        canSignSupplyRequests: false,
        canApproveSupplyRequests: false,
        canAcceptSupplyRequests: false,
        canFulfillSupplyRequests: false,
        canUploadFiles: false,
        canCreateParts: false,
        canEditParts: false,
        canDeleteParts: false,
        canManageUsers: false,
        canEditMasterData: false,
        canEditContracts: false,
        canViewParts: false,
        canManageEmployees: false,
        canViewEmployees: false,
        canManageWorkshops: false,
        canEditWorkshopRepairTemplates: false,
        canEditWorkOrderTemplates: false,
        canViewWarehouseLocations: false,
        canManageWarehouseLocations: false,
        canCloseWorkOrders: false,
        canRevertWorkOrders: false,
        canConfirmEngineDisassemble: false,
        canAssemblyReturn: false,
        canRevertMovements: false,
      }
    : capsBase;
  const availableTabs: MenuTabId[] = [
    ...(authStatus.loggedIn ? (['history'] as const) : []),
    ...(authStatus.loggedIn ? (['user_screens'] as const) : []),
    ...(caps.canViewMasterData ? (['contracts'] as const) : []),
    ...(caps.canViewEngines ? (['engines'] as const) : []),
    ...(caps.canViewReports ? (['assembly_forecast'] as const) : []),
    ...(caps.canViewMasterData ? (['engine_brands'] as const) : []),
    ...(caps.canViewMasterData ? (['engine_brand_groups'] as const) : []),
    ...(caps.canViewMasterData ? (['counterparties'] as const) : []),
    ...(caps.canViewSupplyRequests ? (['requests', 'tool_accounting'] as const) : []),
    ...(caps.canViewMasterData ? (['services', 'services_by_brand'] as const) : []),
    ...(caps.canViewWorkOrders ? (['work_orders'] as const) : []),
    ...(caps.canViewWorkOrders ? (['work_order_templates'] as const) : []),
    // Legacy справочники: меню скрыто, создание/просмотр через Склад → Номенклатура (фильтр по типу).
    // Прямой переход (deeplink, история) по-прежнему работает — компоненты остаются ниже в коде.
    // ...(caps.canViewParts ? (['parts'] as const) : []),
    // ...(caps.canViewMasterData ? (['tools'] as const) : []),
    ...(caps.canViewEmployees ? (['employees'] as const) : []),
    ...(caps.canViewTimesheets ? (['timesheets'] as const) : []),
    ...(caps.canViewMasterData
      ? (['nomenclature', 'parts_dedupe', 'stock_balances', 'warehouse_locations', 'stock_documents', 'stock_receipts', 'stock_issues', 'stock_transfers', 'stock_inventory', 'repair_fund_audit', 'warehouse_analytics', 'engine_assembly_bom'] as const)
      : []),
    ...(caps.canUseUpdates ? (['changes'] as const) : []),
    ...(authStatus.loggedIn ? (['notes'] as const) : []),
    ...(authStatus.loggedIn ? (['drafts'] as const) : []),
    ...(caps.canViewReports ? (['reports', 'custom_reports'] as const) : []),
    ...(caps.canViewMasterData ? (['masterdata'] as const) : []),
    ...(caps.canViewMasterData ? (['empty_cards'] as const) : []),
    ...(caps.canManageWorkshops || caps.canViewMasterData ? (['workshops', 'workshop_stats'] as const) : []),
    ...(caps.canViewWarehouseLocations || caps.canManageWarehouseLocations ? (['warehouses_admin'] as const) : []),
    ...(String(authStatus.user?.role ?? '').toLowerCase() === 'superadmin' ? (['audit', 'access_sections'] as const) : []),
  ];
  const sectionGatedTabs = sectionMembership
    ? availableTabs.filter((t) => {
        const sectionId = SECTION_BY_TAB.get(t);
        return !sectionId || sectionMembership[sectionId] != null;
      })
    : availableTabs;
  const menuState = deriveMenuState(sectionGatedTabs, tabsLayout);
  const visibleTabs = menuState.visibleOrdered;
  const visibleTabsKey = visibleTabs.join('|');
  const userTab: Exclude<
    TabId,
    | 'engine'
    | 'request'
    | 'work_order'
    | 'part'
    | 'tool'
    | 'tool_properties'
    | 'tool_property'
    | 'employee'
    | 'contract'
    | 'engine_brand'
    | 'product'
    | 'service'
    | 'nomenclature_item'
    | 'engine_assembly_bom_item'
    | 'stock_document'
    | 'counterparty'
    | 'report_preset'
  > = authStatus.loggedIn ? 'settings' : 'auth';
  const userLabel = authStatus.loggedIn ? authStatus.user?.username ?? 'Пользователь' : 'Вход';
  const menuLabels: Record<MenuTabId, string> = {
    history: 'История',
    user_screens: 'Мои экраны',
    masterdata: 'Справочники',
    contracts: 'Контракты',
    changes: 'Изменения',
    engines: 'Двигатели',
    assembly_forecast: 'Прогноз сборки',
    engine_brands: 'Марки двигателей',
    engine_brand_groups: 'Группы марок',
    counterparties: 'Контрагенты',
    requests: 'Заявки',
    work_orders: 'Наряды',
    work_order_templates: 'Шаблоны нарядов',
    parts: 'Детали',
    tools: 'Инструменты',
    tool_accounting: 'Учёт инструментов',
    products: 'Товары',
    services: 'Услуги',
    services_by_brand: 'Услуги по маркам',
    nomenclature: 'Номенклатура',
    parts_dedupe: 'Дубли номенклатуры',
    empty_cards: 'Пустые карточки',
    drafts: 'Черновики',
    engine_assembly_bom: 'BOM двигателей',
    stock_balances: 'Остатки',
    stock_documents: 'Документы',
    stock_receipts: 'Приход',
    stock_issues: 'Расход',
    stock_transfers: 'Перемещения',
    stock_inventory: 'Инвентаризация',
    repair_fund_audit: 'Ревизия ремфонда',
    warehouse_analytics: 'Аналитика выпуска',
    workshop_stats: 'Статистика цехов',
    employees: 'Сотрудники',
    timesheets: 'Табель',
    access_sections: 'Доступы по разделам',
    reports: 'Отчёты',
    custom_reports: 'Мои отчёты',
    audit: 'Журнал',
    admin: 'Админ',
    auth: 'Вход',
    notes: 'Заметки',
    settings: 'Настройки',
    workshops: 'Цеха',
    warehouses_admin: 'Склады и цеха',
    warehouse_locations: 'Локации',
  };

  // Gate: без входа показываем только вкладку "Вход".
  useEffect(() => {
    if (!authStatus.loggedIn && tab !== 'auth') setTab('auth');
  }, [authStatus.loggedIn, tab]);

  useEffect(() => {
    if (authStatus.loggedIn && tab === 'auth') setTab('history');
  }, [authStatus.loggedIn, tab]);

  // Gate: chat requires auth + permission.
  useEffect(() => {
    if (!authStatus.loggedIn || !canChat) setChatOpen(false);
  }, [authStatus.loggedIn, canChat]);

  useEffect(() => {
    if (!canAiAgent) setAiChatOpen(false);
  }, [canAiAgent]);

  useEffect(() => {
    if (!trashOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (trashPopupRef.current?.contains(target)) return;
      if (trashButtonRef.current?.contains(target)) return;
      setTrashOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [trashOpen]);

  // For pending users: open chat automatically.
  useEffect(() => {
    const role = String(authStatus.user?.role ?? '').toLowerCase();
    if (authStatus.loggedIn && role === 'pending' && canChat && !chatOpen) setChatOpen(true);
  }, [authStatus.loggedIn, authStatus.user?.role, canChat, chatOpen]);

  function resolveChatSoundUrl(fileName: string) {
    try {
      return new URL(fileName, window.location.href).toString();
    } catch {
      return fileName;
    }
  }

  function ensureChatAudioElements() {
    if (!chatNewMessageAudioRef.current) {
      chatNewMessageAudioRef.current = new Audio(resolveChatSoundUrl(CHAT_NEW_MESSAGE_SOUND_FILE));
      chatNewMessageAudioRef.current.preload = 'auto';
    }
    if (!chatPendingAudioRef.current) {
      chatPendingAudioRef.current = new Audio(resolveChatSoundUrl(CHAT_PENDING_SOUND_FILE));
      chatPendingAudioRef.current.preload = 'auto';
    }
  }

  function stopChatPendingSoundTimer() {
    if (chatPendingSoundTimerRef.current == null) return;
    clearInterval(chatPendingSoundTimerRef.current);
    chatPendingSoundTimerRef.current = null;
  }

  function playChatAudioElement(audio: HTMLAudioElement | null) {
    if (!audio) return;
    try {
      audio.pause();
      audio.currentTime = 0;
      const result = audio.play();
      if (result && typeof result.catch === 'function') {
        void result.catch(() => {
          // Ignore playback errors (eg., autoplay policy).
        });
      }
    } catch {
      // Ignore playback errors to avoid blocking UI.
    }
  }

  function playChatNewMessageSound() {
    ensureChatAudioElements();
    playChatAudioElement(chatNewMessageAudioRef.current);
  }

  function playChatPendingSound() {
    ensureChatAudioElements();
    playChatAudioElement(chatPendingAudioRef.current);
  }

  useEffect(() => {
    ensureChatAudioElements();
    return () => {
      stopChatPendingSoundTimer();
      chatNewMessageAudioRef.current?.pause();
      chatPendingAudioRef.current?.pause();
      chatNewMessageAudioRef.current = null;
      chatPendingAudioRef.current = null;
    };
  }, []);

  // Poll unread count (for the "Открыть чат" counter).
  useEffect(() => {
    if (!authStatus.loggedIn || !canChat || viewMode) return;
    let alive = true;
    const tick = async () => {
      try {
        const r = await window.matrica.chat.unreadCount();
        if (!alive) return;
        if ((r as any)?.ok) setChatUnreadTotal(Number((r as any).total ?? 0));
      } catch {
        // ignore
      }
    };
    void tick();
    const id = setInterval(() => void tick(), 30_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [authStatus.loggedIn, canChat, viewMode]);

  useEffect(() => {
    if (!authStatus.loggedIn || !canChat || viewMode) {
      stopChatPendingSoundTimer();
      chatUnreadTotalRef.current = chatUnreadTotal;
      return;
    }

    const previousUnread = chatUnreadTotalRef.current;

    if (chatUnreadTotal > 0) {
      if (chatUnreadTotal > previousUnread) {
        playChatNewMessageSound();
      }

      if (chatPendingSoundTimerRef.current == null) {
        chatPendingSoundTimerRef.current = window.setInterval(() => {
          if (!authStatus.loggedIn || !canChat || viewMode) return;
          if (chatUnreadTotalRef.current <= 0) return;
          playChatPendingSound();
        }, 60_000);
      }
    } else {
      stopChatPendingSoundTimer();
    }

    chatUnreadTotalRef.current = chatUnreadTotal;
  }, [authStatus.loggedIn, canChat, viewMode, chatUnreadTotal]);

  // Poll burning notes count for tab indicator.
  useEffect(() => {
    if (!authStatus.loggedIn || viewMode) {
      setNotesAlertCount(0);
      return;
    }
    let alive = true;
    const tick = async () => {
      try {
        const r = await window.matrica.notes.burningCount();
        if (!alive) return;
        if ((r as any)?.ok) {
          setNotesAlertCount(Math.max(0, Number((r as any).count ?? 0)));
        }
      } catch {
        // ignore
      }
    };
    void tick();
    const stop = pollWhenVisible(() => void tick(), 60_000);
    return () => {
      alive = false;
      stop();
    };
  }, [authStatus.loggedIn, viewMode]);

  // Poll «Мой круг» notifications (new contracts/ДС reminders) to drive the bell badge on the
  // history group button. Same source as HistoryPage's alert list (loadContractActivityAlerts),
  // so the badge and the section never disagree. Self-extinguishing (3-day createdAt window).
  useEffect(() => {
    if (!authStatus.loggedIn || viewMode) {
      setHistoryAlertCount(0);
      return;
    }
    let alive = true;
    const tick = async () => {
      try {
        const alerts = await loadContractActivityAlerts();
        if (alive) setHistoryAlertCount(alerts.length);
      } catch {
        // ignore — keep last known count
      }
    };
    void tick();
    const stop = pollWhenVisible(() => void tick(), 60_000);
    return () => {
      alive = false;
      stop();
    };
  }, [authStatus.loggedIn, viewMode]);

  // Gate: если вкладка скрылась по permissions/настройкам — переключаем на первую доступную.
  useEffect(() => {
    if (
      tab === 'engine' ||
      tab === 'engine_brand' ||
      tab === 'engine_brand_group' ||
      tab === 'request' ||
      tab === 'work_order' ||
      tab === 'part' ||
      tab === 'tool' ||
      tab === 'tool_properties' ||
      tab === 'tool_property' ||
      tab === 'employee' ||
      tab === 'timesheet' ||
      tab === 'contract' ||
      tab === 'counterparty' ||
      tab === 'product' ||
      tab === 'service' ||
      tab === 'nomenclature_item' ||
      tab === 'engine_assembly_bom_item' ||
      tab === 'stock_document' ||
      tab === 'report_preset' ||
      tab === 'user_screen'
    )
      return;
    if (visibleTabs.includes(tab) || tab === userTab) return;
    setTab(visibleTabs[0] ?? 'auth');
  }, [tab, visibleTabsKey, userTab]);

  async function persistTabsLayout(next: TabsLayoutPrefs) {
    setTabsLayout(next);
    const userId = authStatus.user?.id;
    if (!userId) return;
    await window.matrica.settings.uiSet({ userId, tabsLayout: next }).catch(() => {});
  }

  async function persistShellPrefs(next: UiShellPrefs) {
    setShellPrefs(next);
    const userId = authStatus.user?.id;
    if (!userId) return;
    await window.matrica.settings.uiSet({ userId, shellPrefs: next }).catch(() => {});
  }

  function switchShellVersion(version: UiShellVersion) {
    // Split-панель осмысленна только в v2 — при уходе в v1 закрываем её (без dirty-guard:
    // это осознанное переключение оболочки; primary-карточка остаётся под своим guard'ом).
    if (version === 'v1' && v2SecondaryCard) {
      secondaryCloseRef.current = null;
      setV2SecondaryCard(null);
      setSecondaryEngineDetails(null);
      setSecondaryEngineLoading(false);
    }
    const base = shellPrefs ?? DEFAULT_UI_SHELL_PREFS;
    void persistShellPrefs({ ...base, shellVersion: version });
  }

  function updateV2Prefs(nextV2: V2Prefs) {
    const base = shellPrefs ?? DEFAULT_UI_SHELL_PREFS;
    void persistShellPrefs({ ...base, v2: nextV2 });
  }

  // Общий обработчик кнопок меню (v1 Tabs и v2 ButtonPanel): auth-гейт, спец-ярлык
  // «Прогноз сборки» (открывает пресет отчёта), проверка видимости.
  function handleMenuTab(t: MenuTabId) {
    const isUserTab = t === userTab;
    if (!authStatus.loggedIn && t !== 'auth') {
      setTab('auth');
      return;
    }
    if (!visibleTabs.includes(t) && !isUserTab) return;
    if (t === 'assembly_forecast') {
      openReportPreset('assembly_forecast_7d');
      return;
    }
    setTab(t);
  }

  async function addPinnedShortcut(shortcutId: string) {
    const userId = authStatus.user?.id;
    const id = String(shortcutId ?? '').trim();
    if (!userId || !id) return;
    shortcutsMutationEpochRef.current += 1;
    let nextForSave: string[] = [];
    setPinnedShortcuts((prev) => {
      const list = Array.isArray(prev) ? prev : [];
      nextForSave = list.includes(id) ? list : [...list, id];
      return nextForSave;
    });
    await window.matrica.shortcuts.set({ userId, ids: nextForSave }).catch(() => {});
  }

  async function removePinnedShortcut(shortcutId: string) {
    const userId = authStatus.user?.id;
    if (!userId) return;
    const id = String(shortcutId ?? '').trim();
    shortcutsMutationEpochRef.current += 1;
    let nextForSave: string[] = [];
    setPinnedShortcuts((prev) => {
      const list = Array.isArray(prev) ? prev : [];
      nextForSave = list.filter((x) => x !== id);
      return nextForSave;
    });
    await window.matrica.shortcuts.set({ userId, ids: nextForSave }).catch(() => {});
  }

  function updateHiddenTabs(nextHidden: MenuTabId[]) {
    void persistTabsLayout({
      order: menuState.order,
      hidden: nextHidden,
      trashIndex: menuState.trashIndex,
      ...(tabsLayout?.groupOrder ? { groupOrder: tabsLayout.groupOrder } : {}),
      ...(tabsLayout?.hiddenGroups ? { hiddenGroups: tabsLayout.hiddenGroups } : {}),
      ...(tabsLayout?.collapsedGroups ? { collapsedGroups: tabsLayout.collapsedGroups } : {}),
      ...(tabsLayout?.activeGroup != null ? { activeGroup: tabsLayout.activeGroup } : {}),
    });
  }

  function updateHiddenGroups(nextHiddenGroups: MenuGroupId[]) {
    void persistTabsLayout({
      order: menuState.order,
      hidden: menuState.hidden,
      trashIndex: menuState.trashIndex,
      ...(tabsLayout?.groupOrder ? { groupOrder: tabsLayout.groupOrder } : {}),
      ...(nextHiddenGroups.length > 0 ? { hiddenGroups: nextHiddenGroups } : {}),
      ...(tabsLayout?.collapsedGroups ? { collapsedGroups: tabsLayout.collapsedGroups } : {}),
      ...(tabsLayout?.activeGroup != null ? { activeGroup: tabsLayout.activeGroup } : {}),
    });
  }

  function restoreHiddenTab(id: MenuTabId) {
    const nextHidden = menuState.hidden.filter((x) => x !== id);
    updateHiddenTabs(nextHidden);
  }

  function restoreAllHiddenTabs() {
    if (menuState.hidden.length === 0) return;
    updateHiddenTabs([]);
  }

  function restoreHiddenGroup(id: MenuGroupId) {
    const nextHiddenGroups = menuState.hiddenGroups.filter((x) => x !== id);
    updateHiddenGroups(nextHiddenGroups);
  }

  function restoreAllHiddenGroups() {
    if (menuState.hiddenGroups.length === 0) return;
    updateHiddenGroups([]);
  }

  async function persistChatSide(next: 'left' | 'right') {
    setUiPrefs((prev) => ({ ...prev, chatSide: next }));
    const userId = authStatus.user?.id;
    if (!userId) return;
    await window.matrica.settings.uiSet({ userId, chatSide: next }).catch(() => {});
  }

  // Тема — глобальная (SettingsKey.UiTheme в локальной sysDb), userId не нужен.
  // Оптимистично обновляем стейт (тема применяется сразу через resolvedTheme-эффект), затем пишем.
  async function persistTheme(next: 'auto' | 'light' | 'dark' | 'warm') {
    setUiPrefs((prev) => ({ ...prev, theme: next }));
    await window.matrica.settings.uiSet({ theme: next }).catch(() => {});
  }

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const s = await window.matrica.sync.status();
        if (!alive) return;
        setSyncStatus(s);
      } catch {
        // ignore
      }
    };
    void poll();
    // Индикатор синка — визуальный; сам синк идёт в main-процессе и от этого полла не зависит.
    const stop = pollWhenVisible(() => void poll(), 30_000);
    return () => {
      alive = false;
      stop();
    };
  }, []);

  async function refreshEngines() {
    try {
      const list = await window.matrica.engines.list();
      setEngines((prev) => (sameEngineList(prev, list) ? prev : list));
    } catch (e) {
      const message = String(e ?? '');
      if (message.includes('permission denied')) {
        setEngines([]);
        setPostLoginSyncMsg('Недостаточно прав для просмотра двигателей.');
        setTimeout(() => setPostLoginSyncMsg(''), 12_000);
        return;
      }
      setPostLoginSyncMsg(`Ошибка загрузки двигателей: ${message}`);
      setTimeout(() => setPostLoginSyncMsg(''), 12_000);
    }
  }

  async function openEngine(id: string, opts?: { initialTab?: 'main' | 'details' | 'files' | 'reclamation' }) {
    v2OpenCardGuarded('engine', () => {
      void openEngineNow(id, opts);
    });
  }

  async function openEngineNow(id: string, opts?: { initialTab?: 'main' | 'details' | 'files' | 'reclamation' }) {
    setEngineInitialTab(opts?.initialTab ?? 'main');
    // Смена двигателя: сбросить details ДО переключения, иначе карточка нового id
    // монтируется (key-ремоунт) с чужими stale-атрибутами и «снимок создания»
    // (isNewEngine) фиксируется по чужому номеру — трёхвариантный выбор пути при
    // дубле не предлагается на свежесозданной карточке.
    setEngineDetails((prev) => (prev && prev.id !== id ? null : prev));
    setSelectedEngineId(id);
    setTab('engine');
    setEngineOpenError('');
    setEngineLoading(true);
    try {
      const d = await window.matrica.engines.get(id);
      setEngineDetails((prev) => (sameEngineDetails(prev, d) ? prev : d));
    } catch (e) {
      setEngineDetails(null);
      setEngineOpenError(`Ошибка загрузки двигателя: ${String(e)}`);
    } finally {
      setEngineLoading(false);
    }
  }

  async function openRequest(id: string, opts?: { initialPayload?: SupplyRequestPayload }) {
    v2OpenCardGuarded('request', () => {
      setNewRequestSeed(opts?.initialPayload ? { id, payload: opts.initialPayload } : null);
      setSelectedRequestId(id);
      setTab('request');
    });
  }

  async function openWorkOrder(id: string, opts?: { initialPayload?: WorkOrderPayload }) {
    v2OpenCardGuarded('work_order', () => {
      setNewWorkOrderSeed(opts?.initialPayload ? { id, payload: opts.initialPayload } : null);
      setSelectedWorkOrderId(id);
      setTab('work_order');
    });
  }

  async function openEngineBrand(id: string) {
    v2OpenCardGuarded('engine_brand', () => {
      setSelectedEngineBrandId(id);
      setTab('engine_brand');
    });
  }

  async function openEngineBrandGroup(id: string) {
    v2OpenCardGuarded('engine_brand_group', () => {
      setSelectedEngineBrandGroupId(id);
      setTab('engine_brand_group');
    });
  }

  async function openContract(id: string) {
    v2OpenCardGuarded('contract', () => {
      setSelectedContractId(id);
      setTab('contract');
    });
  }

  // Stage E.2: parts are edited in the nomenclature card now (directory_parts.id ==
  // nomenclature id). Redirect openPart -> openNomenclature; the standalone 'part' tab
  // is kept unreachable for one release (removed in Stage F).
  async function openPart(id: string, opts?: { from?: TabId }) {
    return openNomenclature(id, { from: opts?.from ?? 'parts' });
  }

  async function openTool(id: string) {
    v2OpenCardGuarded('tool', () => {
      setSelectedToolId(id);
      setTab('tool');
    });
  }

  async function openToolProperty(id: string) {
    v2OpenCardGuarded('tool_property', () => {
      setSelectedToolPropertyId(id);
      setTab('tool_property');
    });
  }

  async function openEmployee(id: string) {
    v2OpenCardGuarded('employee', () => {
      setSelectedEmployeeId(id);
      setTab('employee');
    });
  }

  async function openProduct(id: string) {
    v2OpenCardGuarded('product', () => {
      setSelectedProductId(id);
      setTab('product');
    });
  }

  async function openService(id: string, opts?: { from?: TabId }) {
    v2OpenCardGuarded('service', () => {
      setSelectedServiceId(id);
      setServiceOriginTab(opts?.from ?? null);
      setTab('service');
    });
  }

  async function openNomenclature(id: string, opts?: { from?: TabId }) {
    v2OpenCardGuarded('nomenclature_item', () => {
      setSelectedNomenclatureId(id);
      setNomenclatureOriginTab(opts?.from ?? null);
      setTab('nomenclature_item');
    });
  }

  function openUserScreen(id: string) {
    v2OpenCardGuarded('user_screen', () => {
      setSelectedUserScreenId(id);
      setUserScreenEditMode(false);
      setTab('user_screen');
    });
  }

  function editUserScreen(id: string | null) {
    v2OpenCardGuarded('user_screen', () => {
      setSelectedUserScreenId(id ?? 'new');
      setUserScreenEditMode(true);
      setTab('user_screen');
    });
  }

  async function openEngineAssemblyBom(id: string) {
    v2OpenCardGuarded('engine_assembly_bom_item', () => {
      setSelectedEngineAssemblyBomId(id);
      setTab('engine_assembly_bom_item');
    });
  }

  async function openStockDocument(id: string, parentTab: StockDocumentParentTab = 'stock_documents') {
    v2OpenCardGuarded('stock_document', () => {
      setStockDocumentParentTab(parentTab);
      setSelectedStockDocumentId(id);
      setTab('stock_document');
    });
  }

  async function openCounterparty(id: string) {
    v2OpenCardGuarded('counterparty', () => {
      setSelectedCounterpartyId(id);
      setTab('counterparty');
    });
  }

  // Phase 3b: after login, surface any unsaved recovery drafts (crash / forced close /
  // "оставить черновик") once per operator session. Restore navigates to the card, which
  // revives the snapshot on load; discard soft-deletes the draft (synced).
  useEffect(() => {
    if (!authStatus.loggedIn) return;
    const userId = String(authStatus.user?.id ?? '').trim();
    if (!userId || recoveryCheckedUserRef.current === userId) return;
    recoveryCheckedUserRef.current = userId;
    void (async () => {
      try {
        const r = await window.matrica.drafts.list();
        if (r.ok) {
          // Only auto-surface recovery snapshots (crash / forced close). Explicit drafts
          // («Сохранить как черновик», Phase 3c) are intentional — found in the «Черновики»
          // section, not popped on every login.
          const recovery = r.drafts.filter((d) => d.kind === 'recovery');
          if (recovery.length > 0) {
            setRecoveryDrafts(
              recovery.map((d) => ({ id: d.id, cardType: d.cardType, cardId: d.cardId, title: d.title, updatedAt: d.updatedAt })),
            );
          }
        }
      } catch {
        // best-effort — recovery never blocks startup
      }
    })();
  }, [authStatus.loggedIn, authStatus.user?.id]);

  function restoreDraft(d: { cardType: string; cardId: string }) {
    setRecoveryDrafts(null);
    if (d.cardType === 'work_order') void openWorkOrder(d.cardId);
    else if (d.cardType === 'supply_request') void openRequest(d.cardId);
    else if (d.cardType === 'product') openProduct(d.cardId);
    else if (d.cardType === 'service') openService(d.cardId);
    else if (d.cardType === 'counterparty') void openCounterparty(d.cardId);
    else if (d.cardType === 'engine_brand') void openEngineBrand(d.cardId);
    else if (d.cardType === 'contract') void openContract(d.cardId);
    else if (d.cardType === 'engine') void openEngine(d.cardId);
    else if (d.cardType === 'employee') void openEmployee(d.cardId);
  }

  /** Типы карточек, чьи details-страницы умеют открываться из черновика (3d). */
  const DRAFT_OPENABLE_CARD_TYPES = ['work_order', 'supply_request', 'product', 'service', 'counterparty', 'engine_brand', 'contract', 'engine', 'employee'];

  async function discardDraft(d: { id: string }) {
    try {
      await window.matrica.drafts.clear({ id: d.id });
    } catch {
      // best-effort
    }
    setRecoveryDrafts((prev) => {
      const next = (prev ?? []).filter((x) => x.id !== d.id);
      return next.length > 0 ? next : null;
    });
  }

  function openReportPreset(presetId: ReportPresetId) {
    logUiUsage('ui.report_open', presetId);
    v2OpenCardGuarded('report_preset', () => {
      setSelectedReportPresetId(presetId);
      setTab('report_preset');
    });
  }

  const openByCode = {
    customer: openCounterparty,
    counterparty: openCounterparty,
    contract: openContract,
    part: openPart,
    work_order: openWorkOrder,
    engine_brand: openEngineBrand,
    engineBrand: openEngineBrand,
    engine_brand_group: openEngineBrandGroup,
    service: openService,
    product: openProduct,
    nomenclature: openNomenclature,
    employee: openEmployee,
    tool_property: openToolProperty,
  };

  // ── Фаза 3: вкладки открытых карточек (v2) ──────────────────────────────────────
  // Текущая карточка в фокусе = (tab, соответствующий selectedXId).
  function v2CurrentCardIdentity(): { kind: TabId; entityId: string } | null {
    if (!isCardTab(tab)) return null;
    const idByTab: Partial<Record<TabId, string | null>> = {
      engine: selectedEngineId,
      engine_brand: selectedEngineBrandId,
      engine_brand_group: selectedEngineBrandGroupId,
      request: selectedRequestId,
      work_order: selectedWorkOrderId,
      tool: selectedToolId,
      tool_property: selectedToolPropertyId,
      employee: selectedEmployeeId,
      contract: selectedContractId,
      counterparty: selectedCounterpartyId,
      product: selectedProductId,
      service: selectedServiceId,
      nomenclature_item: selectedNomenclatureId,
      engine_assembly_bom_item: selectedEngineAssemblyBomId,
      stock_document: selectedStockDocumentId,
      report_preset: selectedReportPresetId,
      user_screen: selectedUserScreenId,
    };
    const id = idByTab[tab];
    return id ? { kind: tab, entityId: String(id) } : null;
  }

  // V2: закрытие карточки любым путём (onClose после «Сохранить и закрыть» / черновика /
  // удаления) зануляет её selected-id — по этому переходу id→null убираем вкладку из
  // v2OpenCards, иначе зависшая вкладка переоткрывает устаревшее состояние карточки.
  const v2SelectedByKind: Partial<Record<TabId, string | null>> = {
    engine: selectedEngineId,
    engine_brand: selectedEngineBrandId,
    engine_brand_group: selectedEngineBrandGroupId,
    request: selectedRequestId,
    work_order: selectedWorkOrderId,
    tool: selectedToolId,
    tool_property: selectedToolPropertyId,
    employee: selectedEmployeeId,
    contract: selectedContractId,
    counterparty: selectedCounterpartyId,
    product: selectedProductId,
    service: selectedServiceId,
    nomenclature_item: selectedNomenclatureId,
    engine_assembly_bom_item: selectedEngineAssemblyBomId,
    stock_document: selectedStockDocumentId,
    report_preset: selectedReportPresetId,
    user_screen: selectedUserScreenId,
  };
  const v2PrevSelectedRef = useRef<Partial<Record<TabId, string | null>>>({});
  useEffect(() => {
    const prev = v2PrevSelectedRef.current;
    const next: Partial<Record<TabId, string | null>> = {};
    for (const [kind, rawId] of Object.entries(v2SelectedByKind) as Array<[TabId, string | null]>) {
      const id = rawId ? String(rawId) : null;
      next[kind] = id;
      const before = prev[kind];
      if (isV2 && before && !id) {
        setV2OpenCards((cards) => cards.filter((c) => !(c.kind === kind && c.entityId === before)));
      }
    }
    v2PrevSelectedRef.current = next;
  });

  function v2CardTitle(kind: TabId, entityId: string): string {
    if (kind === 'engine') {
      const e = engines.find((x) => x.id === entityId);
      const num = e?.engineNumber?.trim();
      const internal = e?.internalNumberFull?.trim();
      if (num) return internal ? `⚙️ ${num} · ${internal}` : `⚙️ ${num}`;
      if (internal) return `⚙️ ${internal}`;
    }
    return `${appTabTitle(kind)} · ${entityId.slice(0, 6)}`;
  }

  // Переоткрыть карточку по дескриптору (переиспользует open*-хелперы, включая dirty-guard).
  function reopenV2Card(kind: TabId, entityId: string) {
    switch (kind) {
      case 'engine': return void openEngine(entityId);
      case 'engine_brand': return void openEngineBrand(entityId);
      case 'engine_brand_group': return void openEngineBrandGroup(entityId);
      case 'request': return void openRequest(entityId);
      case 'work_order': return void openWorkOrder(entityId);
      case 'tool': return void openTool(entityId);
      case 'tool_property': return void openToolProperty(entityId);
      case 'employee': return void openEmployee(entityId);
      case 'contract': return void openContract(entityId);
      case 'counterparty': return void openCounterparty(entityId);
      case 'product': return void openProduct(entityId);
      case 'service': return void openService(entityId);
      case 'nomenclature_item': return void openNomenclature(entityId);
      case 'engine_assembly_bom_item': return void openEngineAssemblyBom(entityId);
      case 'stock_document': return void openStockDocument(entityId);
      case 'report_preset': return void openReportPreset(entityId as ReportPresetId);
      case 'user_screen': return openUserScreen(entityId);
      default: return;
    }
  }

  function focusV2Card(card: { kind: TabId; entityId: string }) {
    // Не держать одну и ту же карточку и слева, и справа: если фокусируем ту, что сейчас
    // в secondary, — закрываем правую панель (пользователь сам увёл её в primary).
    if (v2SecondaryCard && v2SecondaryCard.kind === card.kind && v2SecondaryCard.entityId === card.entityId) {
      secondaryCloseRef.current = null;
      setV2SecondaryCard(null);
      setSecondaryEngineDetails(null);
      setSecondaryEngineLoading(false);
    }
    reopenV2Card(card.kind, card.entityId);
  }

  // Закрыть вкладку карточки. Фокусную закрываем через dirty-guard; фоновую (single-mount:
  // не смонтирована, значит без несохранённого) — просто убираем из списка.
  function closeV2Card(card: { kind: TabId; entityId: string }) {
    const nextCards = v2OpenCards.filter((c) => !(c.kind === card.kind && c.entityId === card.entityId));
    const idn = v2CurrentCardIdentity();
    const isFocused = !!idn && idn.kind === card.kind && idn.entityId === card.entityId;
    if (!isFocused) {
      setV2OpenCards(nextCards);
      return;
    }
    const nextFocus = nextCards[nextCards.length - 1] ?? null;
    const doAfter = () => {
      setV2CardEpoch((e) => e + 1);
      setV2OpenCards(nextCards);
      if (nextFocus) reopenV2Card(nextFocus.kind, nextFocus.entityId);
      else setTabState(CARD_PARENT_TAB[card.kind] ?? 'history');
    };
    const actions = cardCloseActionsRef.current;
    let dirty = false;
    if (actions) {
      try {
        dirty = Boolean(actions.isDirty());
      } catch {
        dirty = true;
      }
    }
    if (!dirty) {
      if (actions) actions.closeWithoutSave();
      doAfter();
      return;
    }
    pendingCardOpenRef.current = doAfter;
    void closeCardSession({ targetTab: null, appClose: false });
  }

  // ── Split «2 рядом»: вторая (правая) панель ─────────────────────────────────────
  async function loadSecondaryEngine(entityId: string) {
    setSecondaryEngineDetails(null);
    setSecondaryEngineLoading(true);
    try {
      const d = await window.matrica.engines.get(entityId);
      setSecondaryEngineDetails(d);
    } catch {
      setSecondaryEngineDetails(null);
    } finally {
      setSecondaryEngineLoading(false);
    }
  }

  // Закрепить карточку как вторую панель (справа). engine грузится отдельно (не self-load).
  function openSecondaryCard(card: { kind: TabId; entityId: string; title: string }) {
    setV2SecondaryEpoch((e) => e + 1);
    setV2SecondaryCard(card);
    if (card.kind === 'engine') void loadSecondaryEngine(card.entityId);
    else {
      setSecondaryEngineDetails(null);
      setSecondaryEngineLoading(false);
    }
  }

  // Закрыть вторую панель с dirty-guard (по своему secondaryCloseRef).
  function closeSecondaryCard() {
    void closeCardSession({ targetTab: null, appClose: false, panes: ['secondary'] });
  }

  // Учёт открытых карточек: при фокусе на карточке — upsert дескриптора (дедуп, кап 3).
  useEffect(() => {
    if (!isV2) return;
    const idn = v2CurrentCardIdentity();
    if (!idn) return;
    const title = v2CardTitle(idn.kind, idn.entityId);
    setV2OpenCards((prev) => {
      const i = prev.findIndex((c) => c.kind === idn.kind && c.entityId === idn.entityId);
      if (i >= 0) {
        if (prev[i]?.title === title) return prev;
        const next = [...prev];
        next[i] = { kind: idn.kind, entityId: idn.entityId, title };
        return next;
      }
      const next = [...prev, { kind: idn.kind, entityId: idn.entityId, title }];
      while (next.length > V2_MAX_OPEN_CARDS) next.shift();
      return next;
    });
  }, [
    isV2,
    tab,
    selectedEngineId,
    selectedEngineBrandId,
    selectedEngineBrandGroupId,
    selectedRequestId,
    selectedWorkOrderId,
    selectedToolId,
    selectedToolPropertyId,
    selectedEmployeeId,
    selectedContractId,
    selectedCounterpartyId,
    selectedProductId,
    selectedServiceId,
    selectedNomenclatureId,
    selectedEngineAssemblyBomId,
    selectedStockDocumentId,
    selectedReportPresetId,
    engines,
  ]);

  // ── Фаза 4: session-restore открытых карточек между запусками ──────────────────
  // Персист сессии рабочей области (вкладки/фокус/split) в shellPrefs.v2.session.
  // Дебаунс 800мс; сигнатура защищает от echo-записи только что восстановленного.
  const v2SessionSigRef = useRef('');
  useEffect(() => {
    if (!isV2 || !shellPrefs) return;
    const idn = v2CurrentCardIdentity();
    const session: V2Session = {
      openCards: v2OpenCards.map((c) => ({ kind: String(c.kind), entityId: c.entityId, title: c.title })),
      focusedKey: idn ? `${idn.kind}:${idn.entityId}` : null,
      secondary: v2SecondaryCard
        ? { kind: String(v2SecondaryCard.kind), entityId: v2SecondaryCard.entityId, title: v2SecondaryCard.title }
        : null,
    };
    const sig = JSON.stringify(session);
    if (sig === v2SessionSigRef.current) return;
    const t = window.setTimeout(() => {
      v2SessionSigRef.current = sig;
      const base = shellPrefs ?? DEFAULT_UI_SHELL_PREFS;
      void persistShellPrefs({ ...base, v2: { ...base.v2, session } });
    }, 800);
    return () => window.clearTimeout(t);
  }, [
    isV2,
    shellPrefs,
    v2OpenCards,
    v2SecondaryCard,
    tab,
    selectedEngineId,
    selectedEngineBrandId,
    selectedEngineBrandGroupId,
    selectedRequestId,
    selectedWorkOrderId,
    selectedToolId,
    selectedToolPropertyId,
    selectedEmployeeId,
    selectedContractId,
    selectedCounterpartyId,
    selectedProductId,
    selectedServiceId,
    selectedNomenclatureId,
    selectedEngineAssemblyBomId,
    selectedStockDocumentId,
    selectedReportPresetId,
  ]);

  // Восстановление сессии: один раз на пользователя после загрузки prefs в v2.
  // Битые/удалённые сущности не страшны: карточка откроется своим error/empty-состоянием.
  const v2SessionRestoredRef = useRef('');
  useEffect(() => {
    if (!isV2 || !shellPrefs) return;
    const userId = String(authStatus.user?.id ?? '').trim();
    if (!userId || v2SessionRestoredRef.current === userId) return;
    v2SessionRestoredRef.current = userId;
    const session = shellPrefs.v2.session;
    const cards = session.openCards
      .filter((c) => isCardTab(c.kind as TabId))
      .map((c) => ({ kind: c.kind as TabId, entityId: c.entityId, title: c.title }));
    if (cards.length === 0) return;
    v2SessionSigRef.current = JSON.stringify(session);
    setV2OpenCards(cards);
    const focused = cards.find((c) => `${c.kind}:${c.entityId}` === session.focusedKey) ?? cards[cards.length - 1];
    if (focused) reopenV2Card(focused.kind, focused.entityId);
    const sec = session.secondary && isCardTab(session.secondary.kind as TabId) ? session.secondary : null;
    if (sec && !(focused && sec.kind === focused.kind && sec.entityId === focused.entityId)) {
      openSecondaryCard({ kind: sec.kind as TabId, entityId: sec.entityId, title: sec.title });
    }
  }, [isV2, shellPrefs, authStatus.user?.id]);

  function openNoteFromHistory(noteId?: string | null) {
    setHistoryInitialNoteId(noteId ? String(noteId) : null);
    setTab('notes');
  }

  function openChatFromHistory() {
    setChatOpen(true);
  }

  async function navigateToRoute(route: DeepLinkRoute) {
    if (route.kind === 'engine') return await openEngine(route.id);
    if (route.kind === 'request') return await openRequest(route.id);
    if (route.kind === 'part') return await openPart(route.id);
    if (route.kind === 'tool') return await openTool(route.id);
    if (route.kind === 'tool_property') return await openToolProperty(route.id);
    if (route.kind === 'contract') return await openContract(route.id);
    if (route.kind === 'employee') return await openEmployee(route.id);
    if (route.kind === 'product') return await openProduct(route.id);
    if (route.kind === 'service') return await openService(route.id);
    if (route.kind === 'counterparty') return await openCounterparty(route.id);
    if (route.kind === 'nomenclature') return await openNomenclature(route.id);
    if (route.kind === 'stock_document') return await openStockDocument(route.id);
    if (route.kind === 'work_order') return await openWorkOrder(route.id);
    if (route.kind === 'engine_brand') return await openEngineBrand(route.id);
    if (route.kind === 'report_preset') return openReportPreset(route.id as ReportPresetId);
    setTab(route.id as TabId);
  }

  async function navigateDeepLink(link: ChatDeepLinkPayload) {
    return await navigateToRoute(resolveDeepLinkRoute(link));
  }
  navigateDeepLinkRef.current = navigateDeepLink;

  useEffect(() => {
    if (!authStatus.loggedIn || !window.matrica?.app?.onDeepLink) return;
    const unsubscribe = window.matrica.app.onDeepLink((link) => {
      void navigateDeepLinkRef.current(link);
    });
    return () => {
      if (typeof unsubscribe === 'function') unsubscribe();
    };
  }, [authStatus.loggedIn]);

  function shortId(id: string | null) {
    if (!id) return '';
    return id.length > 10 ? `${id.slice(0, 8)}…` : id;
  }

  function buildChatBreadcrumbs() {
    const labels: Record<string, string> = {
      history: 'История',
      masterdata: 'Справочники',
      contracts: 'Контракты',
      contract: 'Карточка контракта',
      counterparties: 'Контрагенты',
      counterparty: 'Карточка контрагента',
      changes: 'Изменения',
      engines: 'Двигатели',
      engine_brands: 'Марки двигателей',
      engine_brand: 'Карточка марки двигателя',
      engine: 'Карточка двигателя',
      requests: 'Закупка деталей',
      request: 'Карточка закупки деталей',
      work_orders: 'Наряды',
      work_order: 'Карточка наряда',
      work_order_templates: 'Шаблоны нарядов',
      parts: 'Детали',
      part: 'Карточка детали',
      tools: 'Инструменты',
      tool_accounting: 'Учёт инструментов',
      tool: 'Карточка инструмента',
      tool_properties: 'Свойства инструментов',
      tool_property: 'Карточка свойства инструмента',
      products: 'Товары',
      product: 'Карточка товара',
      services: 'Услуги',
    services_by_brand: 'Услуги по маркам',
      service: 'Карточка услуги',
      nomenclature: 'Номенклатура',
      engine_assembly_bom: 'BOM двигателей',
      engine_assembly_bom_item: 'Карточка BOM двигателя',
      nomenclature_item: 'Карточка номенклатуры',
      stock_balances: 'Остатки',
      stock_receipts: 'Приход',
      stock_issues: 'Расход',
      stock_transfers: 'Перемещения',
      stock_documents: 'Складские документы',
      stock_document: 'Карточка складского документа',
      stock_inventory: 'Инвентаризация',
      employees: 'Сотрудники',
      employee: 'Карточка сотрудника',
      reports: 'Отчёты',
      report_preset: 'Шаблон отчёта',
      admin: 'Админ',
      notes: 'Заметки',
      settings: 'Настройки',
      auth: 'Вход',
    };
    const parent: Record<string, string> = {
      engine: 'Двигатели',
      engine_brand: 'Марки двигателей',
      request: 'Закупка деталей',
      work_order: 'Наряды',
      part: 'Детали',
      tool: 'Инструменты',
      tool_property: 'Свойства инструментов',
      contract: 'Контракты',
      counterparty: 'Контрагенты',
      employee: 'Сотрудники',
      product: 'Номенклатура',
      service: 'Номенклатура',
      nomenclature_item: 'Номенклатура',
      engine_assembly_bom_item: 'BOM двигателей',
      stock_document: 'Складские документы',
      report_preset: 'Отчёты',
    };

    const crumbs: string[] = [];
    const parentLabel = parent[tab];
    if (parentLabel) crumbs.push(parentLabel);
    const label = labels[tab] ?? String(tab);
    if (label) crumbs.push(label);

    if (tab === 'engine') {
      const attrs = engineDetails?.attributes as Record<string, unknown> | undefined;
      const number = String(attrs?.engine_number ?? '').trim();
      const internal = formatEngineInternalNumber(
        String(attrs?.[ENGINE_INTERNAL_NUMBER_CODE] ?? ''),
        attrs?.[ENGINE_INTERNAL_NUMBER_YEAR_CODE],
      );
      if (number) crumbs.push(internal ? `№ ${number} (внутр. ${internal})` : `№ ${number}`);
      else if (internal) crumbs.push(`внутр. ${internal}`);
      else if (selectedEngineId) crumbs.push(`ID ${shortId(selectedEngineId)}`);
    }
    if (tab === 'engine_brand' && selectedEngineBrandId) crumbs.push(`ID ${shortId(selectedEngineBrandId)}`);
    if (tab === 'request' && selectedRequestId) crumbs.push(`ID ${shortId(selectedRequestId)}`);
    if (tab === 'work_order' && selectedWorkOrderId) crumbs.push(`ID ${shortId(selectedWorkOrderId)}`);
    if (tab === 'tool' && selectedToolId) crumbs.push(`ID ${shortId(selectedToolId)}`);
    if (tab === 'tool_property' && selectedToolPropertyId) crumbs.push(`ID ${shortId(selectedToolPropertyId)}`);
    if (tab === 'contract' && selectedContractId) crumbs.push(`ID ${shortId(selectedContractId)}`);
    if (tab === 'counterparty' && selectedCounterpartyId) crumbs.push(`ID ${shortId(selectedCounterpartyId)}`);
    if (tab === 'employee' && selectedEmployeeId) crumbs.push(`ID ${shortId(selectedEmployeeId)}`);
    if (tab === 'product' && selectedProductId) crumbs.push(`ID ${shortId(selectedProductId)}`);
    if (tab === 'service' && selectedServiceId) crumbs.push(`ID ${shortId(selectedServiceId)}`);
    if (tab === 'nomenclature_item' && selectedNomenclatureId) crumbs.push(`ID ${shortId(selectedNomenclatureId)}`);
    if (tab === 'engine_assembly_bom_item' && selectedEngineAssemblyBomId) crumbs.push(`ID ${shortId(selectedEngineAssemblyBomId)}`);
    if (tab === 'stock_document' && selectedStockDocumentId) crumbs.push(`ID ${shortId(selectedStockDocumentId)}`);
    if (tab === 'report_preset' && selectedReportPresetId) crumbs.push(`Шаблон: ${selectedReportPresetId}`);

    return crumbs.filter(Boolean);
  }

  const aiContext: AiAgentContext = useMemo(
    () => ({
      tab,
      entityId:
        tab === 'engine'
          ? selectedEngineId ?? null
          : tab === 'engine_brand'
            ? selectedEngineBrandId ?? null
            : tab === 'request'
              ? selectedRequestId ?? null
                : tab === 'tool'
                  ? selectedToolId ?? null
                  : tab === 'tool_property'
                    ? selectedToolPropertyId ?? null
                : tab === 'contract'
                  ? selectedContractId ?? null
                  : tab === 'employee'
                    ? selectedEmployeeId ?? null
                    : tab === 'product'
                      ? selectedProductId ?? null
                      : tab === 'service'
                    ? selectedServiceId ?? null
                    : tab === 'counterparty'
                      ? selectedCounterpartyId ?? null
                      : tab === 'nomenclature_item'
                        ? selectedNomenclatureId ?? null
                        : tab === 'stock_document'
                          ? selectedStockDocumentId ?? null
                      : null,
      entityType:
        tab === 'engine'
          ? 'engine'
          : tab === 'engine_brand'
            ? 'engine_brand'
            : tab === 'request'
              ? 'supply_request'
              : tab === 'tool'
                  ? 'tool'
                  : tab === 'tool_property'
                    ? 'tool_property'
                : tab === 'contract'
                  ? 'contract'
                  : tab === 'employee'
                    ? 'employee'
                    : tab === 'product'
                      ? 'product'
                      : tab === 'service'
                    ? 'service'
                    : tab === 'counterparty'
                      ? 'customer'
                      : tab === 'nomenclature_item'
                        ? 'nomenclature'
                        : tab === 'stock_document'
                          ? 'warehouse_document'
                      : null,
      breadcrumbs: buildChatBreadcrumbs(),
    }),
    [
      tab,
      selectedEngineId,
      selectedEngineBrandId,
      selectedRequestId,
      selectedToolId,
      selectedToolPropertyId,
      selectedContractId,
      selectedEmployeeId,
      selectedProductId,
      selectedServiceId,
      selectedCounterpartyId,
      selectedNomenclatureId,
      selectedStockDocumentId,
      selectedReportPresetId,
      engineDetails,
    ],
  );

  useAiAgentTracker({
    enabled: canAiAgent,
    context: aiContext,
    onEvent: (event) => {
      setAiLastEvent(event);
      setAiRecentEvents((prev) => [...prev.slice(-11), event]);
    },
  });

  const currentAppLink = useMemo(
    () => ({
      kind: 'app_link' as const,
      tab,
      engineId: tab === 'engine' ? selectedEngineId ?? null : null,
      engineBrandId: tab === 'engine_brand' ? selectedEngineBrandId ?? null : null,
      requestId: tab === 'request' ? selectedRequestId ?? null : null,
      partId: null,
      toolId: tab === 'tool' ? selectedToolId ?? null : null,
      toolPropertyId: tab === 'tool_property' ? selectedToolPropertyId ?? null : null,
      contractId: tab === 'contract' ? selectedContractId ?? null : null,
      employeeId: tab === 'employee' ? selectedEmployeeId ?? null : null,
      productId: tab === 'product' ? selectedProductId ?? null : null,
      serviceId: tab === 'service' ? selectedServiceId ?? null : null,
      counterpartyId: tab === 'counterparty' ? selectedCounterpartyId ?? null : null,
      nomenclatureId: tab === 'nomenclature_item' ? selectedNomenclatureId ?? null : null,
      stockDocumentId: tab === 'stock_document' ? selectedStockDocumentId ?? null : null,
      reportPresetId: tab === 'report_preset' ? selectedReportPresetId ?? null : null,
      breadcrumbs: buildChatBreadcrumbs(),
    }),
    [
      tab,
      selectedEngineId,
      selectedEngineBrandId,
      selectedRequestId,
      selectedToolId,
      selectedToolPropertyId,
      selectedContractId,
      selectedEmployeeId,
      selectedProductId,
      selectedServiceId,
      selectedCounterpartyId,
      selectedNomenclatureId,
      selectedStockDocumentId,
      selectedReportPresetId,
      engineDetails,
    ],
  );

  useEffect(() => {
    if (!authStatus.loggedIn) return;
    if (isApplyingHistoryRef.current) return;
    if (queuedHistoryReplayRef.current) return;
    const link = currentAppLink as ChatDeepLinkPayload;
    if (!link || link.kind !== 'app_link') return;
    if (link.tab === 'auth') return;

    const normalizedLink: ChatDeepLinkPayload = Array.isArray(link.breadcrumbs)
      ? { ...link, breadcrumbs: [...link.breadcrumbs] }
      : { ...link };
    const signature = appLinkSignature(normalizedLink);
    const truncatedHistory = navigationIndex >= 0 ? navigationHistory.slice(0, navigationIndex + 1) : [];
    const lastStep = truncatedHistory[truncatedHistory.length - 1];
    if (lastStep && appLinkSignature(lastStep.link) === signature) {
      if (truncatedHistory.length !== navigationHistory.length) setNavigationHistory(truncatedHistory);
      if (navigationIndex !== truncatedHistory.length - 1) setNavigationIndex(truncatedHistory.length - 1);
      return;
    }

    const nextHistory = [
      ...truncatedHistory,
      {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
        at: Date.now(),
        link: normalizedLink,
      },
    ].slice(-NAVIGATION_HISTORY_LIMIT);

    setNavigationHistory(nextHistory);
    setNavigationIndex(nextHistory.length - 1);
  }, [authStatus.loggedIn, currentAppLink, navigationHistory, navigationIndex]);

  const canGoBack = navigationIndex > 0;
  const canGoForward = navigationIndex >= 0 && navigationIndex < navigationHistory.length - 1;

  const goBack = useCallback(() => {
    if (navigationIndex <= 0) return;
    const targetIndex = navigationIndex - 1;
    const step = navigationHistory[targetIndex];
    if (!step) return;

    setNavigationIndex(targetIndex);
    if (isCardTab(tab)) {
      queuedHistoryReplayRef.current = {
        step,
        targetIndex,
        rollbackIndex: navigationIndex,
      };
      void closeCardSession({ targetTab: CARD_PARENT_TAB[tab] ?? null, appClose: false }).then(() => {
        if (cardCloseInProgressRef.current) return;
        replayQueuedHistoryStep();
      });
      return;
    }

    replayNavigationStep(step);
  }, [closeCardSession, isCardTab, navigationHistory, navigationIndex, tab]);

  const goForward = useCallback(() => {
    if (navigationIndex < 0 || navigationIndex >= navigationHistory.length - 1) return;
    const targetIndex = navigationIndex + 1;
    const step = navigationHistory[targetIndex];
    if (!step) return;

    setNavigationIndex(targetIndex);
    if (isCardTab(tab)) {
      queuedHistoryReplayRef.current = {
        step,
        targetIndex,
        rollbackIndex: navigationIndex,
      };
      void closeCardSession({ targetTab: CARD_PARENT_TAB[tab] ?? null, appClose: false }).then(() => {
        if (cardCloseInProgressRef.current) return;
        replayQueuedHistoryStep();
      });
      return;
    }

    replayNavigationStep(step);
  }, [closeCardSession, isCardTab, navigationHistory, navigationIndex, tab]);

  useEffect(() => {
    if (!authStatus.loggedIn) return;
    const link = currentAppLink as ChatDeepLinkPayload;
    if (!link || link.kind !== 'app_link') return;
    if (link.tab === 'auth' || link.tab === 'history') return;
    const signature = appLinkSignature(link);
    if (lastRecordedVisitSigRef.current === signature) return;
    lastRecordedVisitSigRef.current = signature;
    const breadcrumbs = Array.isArray(link.breadcrumbs) ? link.breadcrumbs.filter(Boolean) : [];
    const title = (breadcrumbs.length > 0 ? breadcrumbs.join(' / ') : appTabTitle(String(link.tab))).trim();
    if (!title) return;
    const tabForRating = normalizeQuickStartTab(String(link.tab));
    if (tabForRating) {
      setQuickStartScores((prev) => addQuickStartVisit(prev, String(tabForRating), Date.now()));
    }
    setRecentVisits((prev) =>
      upsertRecentVisit(prev, {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
        at: Date.now(),
        title,
        link,
      }),
    );
  }, [authStatus.loggedIn, currentAppLink]);


  async function sendCurrentPositionToChat() {
    if (!authStatus.loggedIn || !canChat) return;
    if (!chatOpen) {
      setPostLoginSyncMsg('Чат закрыт: откройте чат и выберите диалог.');
      setTimeout(() => setPostLoginSyncMsg(''), 6000);
      return;
    }
    if (chatContext.adminMode) {
      setPostLoginSyncMsg('Нельзя отправить ссылку в админ-режиме чата.');
      setTimeout(() => setPostLoginSyncMsg(''), 6000);
      return;
    }
    const r = await window.matrica.chat
      .sendDeepLink({ recipientUserId: chatContext.selectedUserId ?? null, link: currentAppLink as any })
      .catch(() => null);
    if (r && (r as any).ok && !viewMode) void window.matrica.sync.run().catch(() => {});
  }

  async function saveCurrentPositionToNotes() {
    if (!authStatus.loggedIn || viewMode) return;
    const title = buildChatBreadcrumbs().join(' / ').trim() || 'Ссылка на раздел';
    const body = [{ id: crypto.randomUUID(), kind: 'link' as const, appLink: currentAppLink as any }];
    const r = await window.matrica.notes.upsert({ title, body, importance: 'normal' }).catch(() => null);
    if ((r as any)?.ok) {
      setPostLoginSyncMsg('Ссылка на текущий раздел сохранена в заметки.');
      if (!viewMode) void window.matrica.sync.run().catch(() => {});
    } else {
      setPostLoginSyncMsg(`Не удалось сохранить ссылку: ${String((r as any)?.error ?? 'unknown')}`);
    }
    setTimeout(() => setPostLoginSyncMsg(''), 6000);
  }

  function noteToChatText(note: { body: Array<any> }) {
    const lines: string[] = [];
    for (const b of note.body ?? []) {
      if (b?.kind === 'text') lines.push(String(b.text ?? ''));
      if (b?.kind === 'link') {
        if (b.url) lines.push(String(b.url));
        if (b.appLink?.tab) lines.push(`app:${String(b.appLink.tab)}`);
      }
    }
    return lines.join('\n').trim();
  }

  async function sendNoteToChat(note: { body: Array<any> }, recipientUserIds: string[]) {
    if (!authStatus.loggedIn || !canChat) return;
    const recipients = Array.from(new Set((recipientUserIds ?? []).map((x) => String(x).trim()).filter(Boolean)));
    if (recipients.length === 0) {
      setPostLoginSyncMsg('Не выбраны получатели.');
      setTimeout(() => setPostLoginSyncMsg(''), 4500);
      return;
    }
    if (chatContext.adminMode) {
      setPostLoginSyncMsg('Нельзя отправить заметку в админ-режиме чата.');
      setTimeout(() => setPostLoginSyncMsg(''), 6000);
      return;
    }
    const text = noteToChatText(note);
    const imageFileIds = Array.from(
      new Set((note.body ?? []).filter((b) => b?.kind === 'image' && b?.fileId).map((b) => String(b.fileId))),
    );
    let sentCount = 0;
    let failedCount = 0;
    for (const recipientUserId of recipients) {
      if (text) {
        const sentText = await window.matrica.chat.sendText({ recipientUserId, text }).catch(() => null);
        if (sentText && (sentText as any).ok) sentCount += 1;
        else failedCount += 1;
      }
      for (const fileId of imageFileIds) {
        const downloaded = await window.matrica.files.download({ fileId }).catch(() => null);
        if (!downloaded || !(downloaded as any).ok || !(downloaded as any).localPath) {
          failedCount += 1;
          continue;
        }
        const sentFile = await window.matrica.chat
          .sendFile({ recipientUserId, path: String((downloaded as any).localPath) }) // IPC bridge to main (not express res.sendFile); path is an app-downloaded localPath, server-side authz via fileAccessService — nosemgrep
          .catch(() => null);
        if (sentFile && (sentFile as any).ok) sentCount += 1;
        else failedCount += 1;
      }
    }
    if (!viewMode && sentCount > 0) void window.matrica.sync.run().catch(() => {});
    setPostLoginSyncMsg(
      failedCount > 0
        ? `Частично отправлено: успешно ${sentCount}, с ошибкой ${failedCount}`
        : `Отправлено: ${sentCount}`,
    );
    setTimeout(() => setPostLoginSyncMsg(''), 6000);
  }

  async function reloadEngine() {
    if (!selectedEngineId) return;
    setEngineOpenError('');
    setEngineLoading(true);
    try {
      const d = await window.matrica.engines.get(selectedEngineId);
      setEngineDetails((prev) => (sameEngineDetails(prev, d) ? prev : d));
    } catch (e) {
      setEngineDetails(null);
      setEngineOpenError(`Ошибка загрузки двигателя: ${String(e)}`);
    } finally {
      setEngineLoading(false);
    }
  }

  useLiveDataRefresh(
    useCallback(async () => {
      await refreshEngines();
      if (tab === 'engine') await reloadEngine();
    }, [refreshEngines, reloadEngine, tab]),
    {
      enabled: authStatus.loggedIn && tab === 'engine',
      intervalMs: 12000,
      refreshOnSyncDone: false,
    },
  );

  const prevTabRef = useRef<TabId | null>(null);
  useEffect(() => {
    if (tab === 'engines' && prevTabRef.current !== 'engines' && authStatus.loggedIn) {
      void refreshEngines();
    }
    prevTabRef.current = tab;
  }, [tab, authStatus.loggedIn]);

  // Audit page is hidden in client app.

  function triggerEmployeesRefresh() {
    setEmployeesRefreshKey((prev) => prev + 1);
  }

  const pageTitle =
    tab === 'history'
      ? 'Матрица РМЗ — Мой круг'
    : tab === 'engines'
      ? 'Матрица РМЗ — Двигатели'
      : tab === 'engine_brands'
        ? 'Матрица РМЗ — Марки двигателей'
      : tab === 'engine'
        ? 'Матрица РМЗ — Карточка двигателя'
        : tab === 'engine_brand'
          ? 'Матрица РМЗ — Карточка марки двигателя'
        : tab === 'product'
            ? 'Матрица РМЗ — Карточка товара'
            : tab === 'service'
              ? 'Матрица РМЗ — Карточка услуги'
              : tab === 'tool_accounting'
                ? 'Матрица РМЗ — Учёт инструментов'
                : tab === 'nomenclature'
                  ? 'Матрица РМЗ — Номенклатура'
                  : tab === 'nomenclature_item'
                    ? 'Матрица РМЗ — Карточка номенклатуры'
                    : tab === 'engine_assembly_bom'
                      ? 'Матрица РМЗ — BOM двигателей'
                      : tab === 'engine_assembly_bom_item'
                        ? 'Матрица РМЗ — Карточка BOM двигателя'
                    : tab === 'stock_balances'
                      ? 'Матрица РМЗ — Остатки склада'
                      : tab === 'stock_receipts'
                        ? 'Матрица РМЗ — Склад: Приход'
                        : tab === 'stock_issues'
                          ? 'Матрица РМЗ — Склад: Расход'
                          : tab === 'stock_transfers'
                            ? 'Матрица РМЗ — Склад: Перемещения'
                            : tab === 'stock_documents'
                              ? 'Матрица РМЗ — Складские документы'
                              : tab === 'stock_document'
                                ? 'Матрица РМЗ — Карточка складского документа'
                                : tab === 'stock_inventory'
                                  ? 'Матрица РМЗ — Инвентаризация'
        : tab === 'counterparties'
          ? 'Матрица РМЗ — Контрагенты'
          : tab === 'counterparty'
            ? 'Матрица РМЗ — Карточка контрагента'
        : tab === 'changes'
          ? 'Матрица РМЗ — Изменения'
        : tab === 'requests'
          ? 'Матрица РМЗ — Заявки'
          : tab === 'request'
            ? 'Матрица РМЗ — Заявка'
          : tab === 'work_orders'
            ? 'Матрица РМЗ — Наряды'
            : tab === 'work_order'
              ? 'Матрица РМЗ — Карточка наряда'
          : tab === 'parts'
            ? 'Матрица РМЗ — Детали'
                : tab === 'tools'
                  ? 'Матрица РМЗ — Инструменты'
                  : tab === 'tool_properties'
                    ? 'Матрица РМЗ — Свойства инструментов'
                    : tab === 'tool_property'
                      ? 'Матрица РМЗ — Свойство инструмента'
                      : tab === 'tool'
                        ? 'Матрица РМЗ — Карточка инструмента'
          : tab === 'contracts'
            ? 'Матрица РМЗ — Контракты'
            : tab === 'contract'
              ? 'Матрица РМЗ — Карточка контракта'
            : tab === 'employees'
              ? 'Матрица РМЗ — Сотрудники'
              : tab === 'employee'
                ? 'Матрица РМЗ — Карточка сотрудника'
        : tab === 'auth'
          ? 'Матрица РМЗ — Вход'
        : tab === 'settings'
          ? 'Матрица РМЗ — Настройки'
        : tab === 'reports'
          ? 'Матрица РМЗ — Отчёты'
          : tab === 'report_preset'
            ? 'Матрица РМЗ — Шаблон отчёта'
          : tab === 'masterdata'
            ? 'Матрица РМЗ — Справочники'
            : tab === 'admin'
              ? 'Матрица РМЗ — Админ'
          : 'Матрица РМЗ — Журнал';

  const showUpdateBanner =
    updateStatus &&
    ['downloading', 'downloaded', 'error', 'checking'].includes(String(updateStatus.state));
  const updateSourceLabel = (() => {
    const src = String(updateStatus?.source ?? '').toLowerCase();
    if (src === 'yandex') return 'Yandex';
    if (src === 'github') return 'GitHub';
    if (src === 'torrent') return 'Торрент';
    if (src === 'lan') return 'Локальная сеть';
    if (src === 'server') return 'Сервер';
    return '';
  })();
  const updateBannerText = (() => {
    if (!updateStatus) return '';
    if (updateStatus.state === 'downloading') {
      const pct = Math.max(0, Math.min(100, Math.floor(updateStatus.progress ?? 0)));
      const src = updateSourceLabel ? ` (${updateSourceLabel})` : '';
      return `Скачиваем обновление${src}… ${pct}%`;
    }
    if (updateStatus.state === 'checking') {
      const src = updateSourceLabel ? ` (${updateSourceLabel})` : '';
      return `Проверяем обновления${src}…`;
    }
    if (updateStatus.state === 'downloaded') {
      const src = updateSourceLabel ? ` (${updateSourceLabel})` : '';
      return `Обновление скачано${src}, установка после перезапуска.`;
    }
    if (updateStatus.state === 'error') return `Ошибка обновления: ${updateStatus.message ?? 'unknown'}`;
    if (updateStatus.message) return String(updateStatus.message);
    return '';
  })();

  function recordFatalError(error: Error, info?: React.ErrorInfo | null) {
    const message = error?.message || String(error);
    const stack = error?.stack || info?.componentStack || '';
    setFatalError({ message, stack });
    setFatalOpen(true);
    window.matrica?.log?.send?.('error', `renderer fatal: ${message}\n${stack}`).catch(() => {});
  }

  function formatDuration(ms: number | null | undefined) {
    if (!ms || ms <= 0) return '0:00';
    const totalSec = Math.max(0, Math.round(ms / 1000));
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    return `${min}:${String(sec).padStart(2, '0')}`;
  }

  const syncTableLabels: Record<string, string> = {
    entity_types: 'Справочники: типы сущностей',
    entities: 'Данные: сущности',
    attribute_defs: 'Справочники: поля и атрибуты',
    attribute_values: 'Данные: значения атрибутов',
    operations: 'Производство: операции',
    audit_log: 'Безопасность: аудит',
    chat_messages: 'Чат: сообщения',
    chat_reads: 'Чат: прочтения',
    user_presence: 'Чат: присутствие',
    notes: 'Заметки',
    note_shares: 'Заметки: доступы',
  };

  const syncServiceLabels: Record<string, string> = {
    schema: 'Сервис: схема и совместимость',
    diagnostics: 'Сервис: диагностика клиента',
    ledger: 'Сервис: ledger',
    sync: 'Сервис: синхронизация',
  };
  const entityTypeLabels: Record<string, string> = {
    engine: 'Двигатели',
    engine_brand: 'Марки двигателей',
    customer: 'Заказчики',
    contract: 'Контракты',
    work_order: 'Наряды',
    workshop: 'Цеха',
    section: 'Участки',
    department: 'Подразделения',
    product: 'Товары',
    service: 'Услуги',
    category: 'Категории',
    employee: 'Сотрудники',
    part: 'Запчасти',
    unit: 'Единицы измерения',
    store: 'Склады',
    engine_node: 'Узлы двигателя',
    link_field_rule: 'Подсказки link-полей',
    tool: 'Инструменты',
    tool_property: 'Свойства инструмента',
    tool_catalog: 'Каталог инструмента',
  };

  function formatSyncActivity(evt: SyncProgressEvent): string | null {
    if (!evt) return null;
    const stageLabel = evt.stage
      ? {
          prepare: 'Подготовка',
          push: 'Отправка изменений',
          pull: 'Получение изменений',
          apply: 'Применение изменений',
          ledger: 'Синхронизация ledger',
          finalize: 'Завершение',
        }[evt.stage] ?? evt.stage
      : '';
    const serviceLabel = evt.service ? syncServiceLabels[evt.service] ?? `Сервис: ${evt.service}` : '';
    const tableLabel = evt.table ? syncTableLabels[String(evt.table)] ?? String(evt.table) : '';
    let breakdownText = '';
    if (evt.breakdown?.entityTypes) {
      const entries = Object.entries(evt.breakdown.entityTypes)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6)
        .map(([code, count]) => `${entityTypeLabels[code] ?? code}=${count}`);
      const suffix = Object.keys(evt.breakdown.entityTypes).length > 6 ? ', ...' : '';
      if (entries.length > 0) breakdownText = `по типам: ${entries.join(', ')}${suffix}`;
    }
    const parts = [stageLabel, serviceLabel, tableLabel, evt.detail, breakdownText].filter(
      (v) => !!v && String(v).trim().length > 0,
    ) as string[];
    if (parts.length === 0) return null;
    return parts.join(' • ');
  }

  function pushSyncHistory(prev: Array<{ at: number; text: string }>, text: string) {
    const now = Date.now();
    const list = Array.isArray(prev) ? [...prev] : [];
    const last = list[list.length - 1];
    if (last && last.text === text) {
      last.at = now;
      return list;
    }
    list.push({ at: now, text });
    if (list.length > 6) list.splice(0, list.length - 6);
    return list;
  }

  function renderFullSyncModal() {
    if (!fullSyncUi?.open) return null;
    const pct = fullSyncUi.progress != null ? Math.max(0, Math.min(100, Math.round(fullSyncUi.progress * 100))) : 0;
    return (
      <div
        style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(15, 23, 42, 0.6)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 1100,
          padding: 20,
        }}
      >
        <div style={{ width: 'min(560px, 95vw)', background: 'var(--surface)', borderRadius: 14, padding: 16 }}>
          <div style={{ fontWeight: 800, fontSize: 16 }}>Полная синхронизация</div>
          <div style={{ marginTop: 8, color: 'var(--muted)' }}>
            Выполняется полная синхронизация с главной базой предприятия. Пожалуйста дождитесь окончания операции.
          </div>
          <div style={{ marginTop: 12 }}>
            <div
              style={{
                position: 'relative',
                height: 18,
                borderRadius: 999,
                background: '#e2e8f0',
                overflow: 'hidden',
                border: '1px solid rgba(37, 99, 235, 0.35)',
              }}
            >
              <div
                style={{
                  position: 'absolute',
                  inset: 0,
                  width: `${pct}%`,
                  background: '#2563eb',
                  transition: 'width 0.4s ease',
                }}
              />
              <div
                style={{
                  position: 'absolute',
                  inset: 0,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '0 10px',
                  color: '#fff',
                  fontWeight: 700,
                  fontSize: 11,
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                }}
              >
                <span>Прогресс: {pct}%</span>
                <span>Осталось ~ {formatDuration(fullSyncUi.etaMs)}</span>
              </div>
            </div>
          </div>
          {fullSyncUi.activity && (
            <div style={{ marginTop: 10, color: 'var(--muted)', fontSize: 12 }}>
              Сейчас: {fullSyncUi.activity}
            </div>
          )}
          {fullSyncUi.history && fullSyncUi.history.length > 1 && (
            <div style={{ marginTop: 8, color: 'var(--muted)', fontSize: 12 }}>
              {fullSyncUi.history.slice().reverse().map((item) => (
                <div key={`${item.at}-${item.text}`}>• {item.text}</div>
              ))}
            </div>
          )}
          {fullSyncUi.error && (
            <div style={{ marginTop: 10, color: 'var(--danger)' }}>
              Ошибка синхронизации: {fullSyncUi.error}
            </div>
          )}
          {fullSyncUi.error && (
            <div style={{ marginTop: 12, display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <Button variant="ghost" onClick={() => setFullSyncUi(null)}>
                Закрыть
              </Button>
            </div>
          )}
        </div>
      </div>
    );
  }

  // Enter закрывает окно приветствия (доп. способ к кнопке «За работу!»).
  useEffect(() => {
    if (!releaseWelcomeUi.open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || releaseWelcomeUi.closing) return;
      e.preventDefault();
      void closeReleaseWelcome();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [releaseWelcomeUi.open, releaseWelcomeUi.closing]);

  // Ctrl/Cmd+K — global search palette. Disabled while the welcome window is up.
  useEffect(() => {
    if (!authStatus.loggedIn) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'k') return;
      if (releaseWelcomeUi.open) return;
      e.preventDefault();
      setGlobalSearchOpen((v) => !v);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [authStatus.loggedIn, releaseWelcomeUi.open]);

  async function closeReleaseWelcome() {
    setReleaseWelcomeUi((prev) => ({ ...prev, closing: true }));
    try {
      await window.matrica.settings.releaseWelcomeAcknowledge();
    } catch {
      // ignore and still close locally
    } finally {
      setReleaseWelcomeUi((prev) => ({ ...prev, open: false, closing: false }));
    }
  }

  function renderReleaseWelcomeModal() {
    if (!releaseWelcomeUi.open || !releaseWelcomeUi.content) return null;
    const c = releaseWelcomeUi.content;
    const teleprompterItems = [
      { kind: 'intro' as const, text: c.intro },
      ...c.highlights.map((item) => ({ kind: 'highlight' as const, text: item })),
      { kind: 'outro' as const, text: c.outro },
    ];
    const releaseLabel = c.releaseLabel || (releaseWelcomeUi.currentVersion ? `v${releaseWelcomeUi.currentVersion}` : 'MatricaRMZ');
    const parts: Array<{ kind: 'gear' | 'piston' | 'bolt' | 'nut' | 'ring' | 'rod' | 'valve' | 'spark'; cls: string }> = [
      { kind: 'gear', cls: 'release-welcome-part--gear-1' },
      { kind: 'piston', cls: 'release-welcome-part--piston-1' },
      { kind: 'bolt', cls: 'release-welcome-part--bolt-1' },
      { kind: 'nut', cls: 'release-welcome-part--nut-1' },
      { kind: 'ring', cls: 'release-welcome-part--ring-1' },
      { kind: 'gear', cls: 'release-welcome-part--gear-2' },
      { kind: 'rod', cls: 'release-welcome-part--rod-1' },
      { kind: 'valve', cls: 'release-welcome-part--valve-1' },
      { kind: 'spark', cls: 'release-welcome-part--spark-1' },
      { kind: 'gear', cls: 'release-welcome-part--gear-3' },
      { kind: 'bolt', cls: 'release-welcome-part--bolt-2' },
      { kind: 'ring', cls: 'release-welcome-part--ring-2' },
      { kind: 'nut', cls: 'release-welcome-part--nut-2' },
      { kind: 'piston', cls: 'release-welcome-part--piston-2' },
      { kind: 'gear', cls: 'release-welcome-part--gear-4' },
      { kind: 'piston', cls: 'release-welcome-part--piston-3' },
      { kind: 'bolt', cls: 'release-welcome-part--bolt-3' },
      { kind: 'nut', cls: 'release-welcome-part--nut-3' },
      { kind: 'ring', cls: 'release-welcome-part--ring-3' },
      { kind: 'rod', cls: 'release-welcome-part--rod-2' },
      { kind: 'valve', cls: 'release-welcome-part--valve-2' },
      { kind: 'spark', cls: 'release-welcome-part--spark-2' },
    ];
    return (
      <div className="release-welcome-overlay">
        <div className="release-welcome-aurora release-welcome-aurora--one" />
        <div className="release-welcome-aurora release-welcome-aurora--two" />
        <div className="release-welcome-aurora release-welcome-aurora--three" />
        <div className="release-welcome-parts" aria-hidden="true">
          {parts.map((p, i) => (
            <span key={i} className={`release-welcome-part release-welcome-part--${p.kind} ${p.cls}`}>
              {renderEnginePartSvg(p.kind)}
            </span>
          ))}
        </div>
        <div className="release-welcome-card">
          <div className="release-welcome-topbar">
            <div className="release-welcome-support">
              <span className="release-welcome-support-icon" aria-hidden="true">📞</span>
              <div className="release-welcome-support-text">
                <div className="release-welcome-support-title">Техподдержка</div>
                <div className="release-welcome-support-phone">+7 (922) 900-5910</div>
                <div className="release-welcome-support-person">Валентин Савиных, инженер-программист</div>
              </div>
            </div>
            <div className="release-welcome-badge">Обновление {releaseLabel}</div>
          </div>
          {c.epigraph ? (
            <blockquote className="release-welcome-epigraph">«{c.epigraph}»</blockquote>
          ) : (
            <h2 className="release-welcome-title">{c.title}</h2>
          )}
          <div className="release-welcome-subheading">
            <span className="release-welcome-subheading-icon" aria-hidden="true">✨</span>
            <span>Что нового в программе</span>
          </div>
          {/* Кнопка закрытия — НАД текстом: на низких экранах она не уезжает за край,
              остаётся доступной даже если список «что нового» не влез. Enter — тоже закрывает. */}
          <div className="release-welcome-actions">
            <Button
              size="lg"
              onClick={() => void closeReleaseWelcome()}
              disabled={releaseWelcomeUi.closing}
              style={{
                minHeight: 48,
                minWidth: 240,
                fontSize: 18,
                padding: '10px 22px',
                fontWeight: 800,
                letterSpacing: 0.2,
                boxShadow: '0 12px 28px rgba(37, 99, 235, 0.42)',
              }}
            >
              {releaseWelcomeUi.closing ? 'Закрываю...' : 'За работу! (Enter)'}
            </Button>
          </div>
          <div className="release-welcome-teleprompter-shell">
            <div className="release-welcome-teleprompter-glow release-welcome-teleprompter-glow--one" />
            <div className="release-welcome-teleprompter-glow release-welcome-teleprompter-glow--two" />
            <div className="release-welcome-teleprompter-mask release-welcome-teleprompter-mask--top" />
            <div className="release-welcome-teleprompter-mask release-welcome-teleprompter-mask--bottom" />
            <div className="release-welcome-teleprompter-viewport">
              <div className="release-welcome-teleprompter-track">
                {[0, 1].map((copyIdx) => (
                  <div key={`teleprompter-copy-${copyIdx}`} className="release-welcome-teleprompter-sequence">
                    {teleprompterItems.map((item, idx) => (
                      <div
                        key={`${copyIdx}-${idx}-${item.text}`}
                        className={
                          item.kind === 'highlight'
                            ? 'release-welcome-teleprompter-item release-welcome-teleprompter-item--highlight'
                            : 'release-welcome-teleprompter-item'
                        }
                      >
                        {item.kind === 'highlight' ? <span className="release-welcome-list-dot">✦</span> : null}
                        <span>{item.text}</span>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          </div>
          <div className="release-welcome-meta">
            {releaseWelcomeUi.previousVersion
              ? `Прошлая версия здесь: v${releaseWelcomeUi.previousVersion} → теперь ${releaseLabel}`
              : 'Добро пожаловать в MatricaRMZ!'}
          </div>
        </div>
      </div>
    );
  }

  function renderCardCloseModal() {
    if (!cardCloseModalOpen) return null;
    return (
      <div
        style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(15, 23, 42, 0.6)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 1200,
          padding: 20,
        }}
      >
        <div style={{ width: 'min(560px, 95vw)', background: 'var(--surface)', borderRadius: 14, padding: 16 }}>
          <div style={{ fontWeight: 800, fontSize: 16 }}>
            {cardClosePaneCount > 1 ? `Закрываются ${cardClosePaneCount} карточки` : 'Карточка закрывается'}
          </div>
          <div style={{ marginTop: 8, color: 'var(--muted)' }}>
            {cardClosePaneCount > 1
              ? 'В обеих панелях есть несохранённые изменения. Сохранить все или отклонить все?'
              : cardCloseSupportsDraft
                ? 'В карточке есть несохранённые изменения. Сохранить их, отклонить или оставить черновик для восстановления позже?'
                : 'Сохранить изменения в карточке?'}
          </div>
          <div style={{ marginTop: 10, color: 'var(--muted)' }}>
            {cardClosePaneCount > 1
              ? 'Пока не выберете действие, изменения не сохраняются, карточки остаются открытыми.'
              : cardCloseSupportsDraft
                ? `Если не выбрать действие, изменения останутся черновиком через ${cardCloseCountdown} сек.`
                : 'Пока не выберете действие, изменения не сохраняются, карточка остаётся открытой.'}
          </div>
          {cardCloseStatus ? <div style={{ marginTop: 8, color: 'var(--danger)' }}>{cardCloseStatus}</div> : null}
          <div style={{ marginTop: 14, display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
            <Button tone="danger" variant="ghost" onClick={() => void finalizeCardClose('discard')}>
              {cardClosePaneCount > 1 ? 'Не сохранять все' : 'Не сохранять'}
            </Button>
            {cardCloseSupportsDraft && cardClosePaneCount === 1 ? (
              <Button variant="ghost" onClick={() => void finalizeCardClose('keepDraft')}>
                Оставить черновик
              </Button>
            ) : null}
            <Button variant="ghost" tone="success" onClick={() => void finalizeCardClose('save')}>
              {cardClosePaneCount > 1 ? 'Сохранить все' : 'Сохранить'}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  function renderAppCloseSyncOverlay() {
    if (!appCloseSyncing) return null;
    return (
      <div
        style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(15, 23, 42, 0.6)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 1300,
          padding: 20,
        }}
      >
        <div style={{ width: 'min(420px, 90vw)', background: 'var(--surface)', borderRadius: 14, padding: 20, textAlign: 'center' }}>
          <div style={{ fontWeight: 800, fontSize: 16 }}>Синхронизация с сервером…</div>
          <div style={{ marginTop: 8, color: 'var(--muted)' }}>
            Отправляем несохранённые изменения на сервер. Программа закроется автоматически.
          </div>
        </div>
      </div>
    );
  }

  function renderRecoveryModal() {
    if (!recoveryDrafts || recoveryDrafts.length === 0) return null;
    return (
      <div
        style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(15, 23, 42, 0.6)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 1200,
          padding: 20,
        }}
      >
        <div style={{ width: 'min(620px, 95vw)', maxHeight: '80vh', overflow: 'auto', background: 'var(--surface)', borderRadius: 14, padding: 16 }}>
          <div style={{ fontWeight: 800, fontSize: 16 }}>Восстановление несохранённых карточек</div>
          <div style={{ marginTop: 8, color: 'var(--muted)' }}>
            Найдены несохранённые изменения (после сбоя или закрытия без сохранения). Восстановить карточку или отклонить черновик?
          </div>
          <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {recoveryDrafts.map((d) => (
              <div
                key={d.id}
                style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderRadius: 10, background: 'var(--surface-2, rgba(148,163,184,0.12))' }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {d.title?.trim() || `Черновик ${d.cardId.slice(0, 8)}…`}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                    изменён {new Date(d.updatedAt).toLocaleString('ru-RU')}
                  </div>
                </div>
                <Button
                  variant="ghost"
                  tone="success"
                  onClick={() => restoreDraft(d)}
                  disabled={!DRAFT_OPENABLE_CARD_TYPES.includes(d.cardType)}
                >
                  Восстановить
                </Button>
                <Button variant="ghost" tone="danger" onClick={() => void discardDraft(d)}>
                  Отклонить
                </Button>
              </div>
            ))}
          </div>
          <div style={{ marginTop: 14, display: 'flex', justifyContent: 'flex-end' }}>
            <Button variant="ghost" onClick={() => setRecoveryDrafts(null)}>
              Позже
            </Button>
          </div>
        </div>
      </div>
    );
  }

  function renderFatalModal() {
    if (!fatalOpen || !fatalError) return null;
    const details = `${fatalError.message}\n${fatalError.stack ?? ''}`.trim();
    return (
      <div
        style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(15, 23, 42, 0.6)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 1000,
          padding: 20,
        }}
      >
        <div style={{ width: 'min(640px, 95vw)', background: 'var(--surface)', borderRadius: 14, padding: 16 }}>
          <div style={{ fontWeight: 800, fontSize: 16 }}>Ошибка интерфейса</div>
          <div style={{ marginTop: 8, color: 'var(--muted)' }}>
            Произошла ошибка. Скопируйте текст и отправьте разработчику.
          </div>
          <pre
            style={{
              marginTop: 12,
              padding: 10,
              borderRadius: 10,
              background: 'var(--input-bg)',
              border: '1px solid var(--border)',
              maxHeight: 240,
              overflow: 'auto',
              whiteSpace: 'pre-wrap',
              fontSize: 12,
            }}
          >
            {details || 'Нет подробностей.'}
          </pre>
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <Button
              onClick={() => {
                void navigator.clipboard?.writeText(details);
              }}
            >
              Скопировать для разработчика
            </Button>
            <div style={{ flex: 1 }} />
            <Button variant="ghost" onClick={() => setFatalOpen(false)}>
              Закрыть
            </Button>
          </div>
        </div>
      </div>
    );
  }

  const headerInlineStatusText = postLoginSyncMsg && /(ошиб|не удалось|недостаточно)/i.test(postLoginSyncMsg) ? postLoginSyncMsg : '';

  const headerStatus = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', minWidth: 0, overflow: 'hidden', justifyContent: 'center' }}>
      <div
        style={{
          position: 'relative',
          height: 16,
          flex: '1 1 auto',
          minWidth: 0,
          background: showUpdateBanner ? 'rgba(148, 163, 184, 0.35)' : 'transparent',
          overflow: 'hidden',
          opacity: showUpdateBanner ? 1 : 0,
          transition: 'opacity 140ms ease',
        }}
      >
        <div
          style={{
            position: 'absolute',
            inset: 0,
            width: `${Math.max(0, Math.min(100, Math.floor(updateStatus?.progress ?? 0)))}%`,
            background: '#2563eb',
          }}
        />
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '0 8px',
            fontSize: 11,
            color: '#ffffff',
            textShadow: '0 1px 2px rgba(15, 23, 42, 0.8)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {showUpdateBanner ? `${updateBannerText}${updateStatus?.version ? ` v${String(updateStatus.version)}` : ''}` : ''}
        </div>
      </div>
      <div
        style={{
          flex: '1 1 auto',
          minWidth: 0,
          fontSize: 12,
          color: incrementalSyncUi?.error ? '#fecaca' : '#ffffff',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          textAlign: 'center',
          minHeight: 16,
          lineHeight: '16px',
          opacity: headerInlineStatusText ? 1 : 0,
          transition: 'opacity 140ms ease',
        }}
      >
        {headerInlineStatusText || ' '}
      </div>
    </div>
  );
  const edgeSide = uiPrefs.chatSide;
  const edgeButtonStyle: React.CSSProperties = {
    writingMode: 'vertical-rl',
    textOrientation: 'mixed',
    padding: '6px 4px',
    minWidth: 26,
    fontSize: 11,
    fontWeight: 700,
  };
  const edgeMoveButtonStyle: React.CSSProperties = {
    ...edgeButtonStyle,
    writingMode: 'horizontal-tb',
    textOrientation: 'mixed',
    padding: '6px 8px',
    minWidth: 36,
    fontSize: 14,
    lineHeight: '14px',
  };
  const quickStartRatings = useMemo(
    () => projectQuickStartRatings(quickStartScores),
    [quickStartScores],
  );

  // Card remount key: id + v2-эпоха (см. v2CardEpoch). В v1 эпоха константна —
  // поведение key={id} байт-в-байт.
  const cardKey = (id: string) => `${id}::${v2CardEpoch}`;

  // ── Split: рендер второй (правой) панели по (kind, entityId) ────────────────────
  // Параметризованный рендерер: те же detail-страницы, что и в primary, но по произвольному
  // id и со своим close-ref (registerSecondaryCardCloseActions) и onClose=closeSecondaryCard.
  // engine — единственная не-self-load карточка (нужен готовый объект secondaryEngineDetails).
  function renderSecondaryCard(): React.ReactNode {
    const card = v2SecondaryCard;
    if (!card) return null;
    const id = card.entityId;
    const k = `${card.kind}:${id}:${v2SecondaryEpoch}`;
    const reg = registerSecondaryCardCloseActions;
    const close = closeSecondaryCard;
    switch (card.kind) {
      case 'engine':
        if (secondaryEngineLoading || !secondaryEngineDetails) {
          return <div style={{ padding: 16, color: 'var(--muted)' }}>{secondaryEngineLoading ? 'Загрузка карточки двигателя…' : 'Нет данных для отображения.'}</div>;
        }
        return (
          <EngineDetailsPage
            key={k}
            engineId={id}
            engine={secondaryEngineDetails}
            onReload={() => loadSecondaryEngine(id)}
            onEngineUpdated={async () => { await refreshEngines(); await loadSecondaryEngine(id); }}
            canEditEngines={caps.canEditEngines}
            currentUserId={String(authStatus.user?.id ?? '')}
            currentUserRole={userRole}
            canViewOperations={caps.canViewOperations}
            canEditOperations={caps.canEditOperations}
            canPrintEngineCard={caps.canPrintReports}
            canViewMasterData={caps.canViewMasterData}
            canEditMasterData={caps.canEditMasterData}
            canExportReports={caps.canExportReports}
            canViewFiles={caps.canViewFiles}
            canUploadFiles={caps.canUploadFiles}
            canConfirmEngineDisassemble={caps.canConfirmEngineDisassemble}
            canAssemblyReturn={caps.canAssemblyReturn}
            currentUserProfile={currentUserProfile ? { fullName: currentUserProfile.fullName, position: currentUserProfile.position } : null}
            registerCardCloseActions={reg}
            requestClose={close}
            onOpenEngine={(x: string) => void openEngine(x)}
            onOpenEngineReclamation={(x: string) => void openEngine(x, { initialTab: 'reclamation' })}
            initialTab="main"
            onOpenEngineBrand={openEngineBrand}
            onOpenCounterparty={openCounterparty}
            onOpenContract={openContract}
            onOpenSupplyRequest={openRequest}
            canCreateSupplyRequest={caps.canCreateSupplyRequests && caps.canEditSupplyRequests}
            canCreateWorkOrder={caps.canCreateWorkOrders}
            onOpenWorkOrder={(x: string) => void openWorkOrder(x)}
            onClose={close}
          />
        );
      case 'engine_brand':
        return (
          <EngineBrandDetailsPage key={k} brandId={id} canEdit={caps.canEditMasterData} canViewParts={caps.canViewParts} canCreateParts={caps.canCreateParts} canEditParts={caps.canEditParts} canViewMasterData={caps.canViewMasterData} onOpenPart={openPart} canViewFiles={caps.canViewFiles} canUploadFiles={caps.canUploadFiles} registerCardCloseActions={reg} requestClose={close} onClose={close} />
        );
      case 'engine_brand_group':
        return <EngineBrandGroupDetailsPage key={k} groupId={id} canEdit={caps.canEditMasterData} canViewMasterData={caps.canViewMasterData} onClose={close} />;
      case 'request':
        return (
          <SupplyRequestDetailsPage key={k} id={id} canEdit={caps.canEditSupplyRequests} canSign={caps.canSignSupplyRequests} canApprove={caps.canApproveSupplyRequests} canAccept={caps.canAcceptSupplyRequests} canFulfill={caps.canFulfillSupplyRequests} canPrint={caps.canPrintSupplyRequests} canViewMasterData={caps.canViewMasterData} canEditMasterData={caps.canEditMasterData} canViewFiles={caps.canViewFiles} canUploadFiles={caps.canUploadFiles} userPosition={currentUserProfile?.position ?? null} userRole={authStatus.user?.role ?? null} userDepartmentId={currentUserProfile?.sectionId ?? null} registerCardCloseActions={reg} requestClose={close} onOpenProduct={openProduct} onOpenService={openService} onOpenNomenclature={openNomenclature} onOpenPart={openPart} onClose={close} />
        );
      case 'work_order':
        return (
          <WorkOrderDetailsPage key={k} id={id} canEdit={caps.canEditWorkOrders} canEditMasterData={caps.canEditMasterData} canCreateParts={caps.canCreateParts} canCreateEmployees={caps.canManageEmployees} canCloseWorkOrders={caps.canCloseWorkOrders} canEditWorkshopRepairTemplates={caps.canEditWorkshopRepairTemplates} canEditWorkOrderTemplates={caps.canEditWorkOrderTemplates} registerCardCloseActions={reg} requestClose={close} onOpenPart={openPart} onOpenService={openService} onOpenEmployee={openEmployee} onClose={close} />
        );
      case 'contract':
        return (
          <ContractDetailsPage key={k} contractId={id} canEdit={caps.canEditContracts} canEditMasterData={caps.canEditMasterData} canViewFiles={caps.canViewFiles} canUploadFiles={caps.canUploadFiles} registerCardCloseActions={reg} requestClose={close} onClose={close} onOpenCounterparty={openCounterparty} onOpenEngine={openEngine} onOpenPart={openPart} onOpenEngineBrand={openEngineBrand} />
        );
      case 'counterparty':
        return (
          <CounterpartyDetailsPage key={k} counterpartyId={id} canEdit={caps.canEditContracts} canViewFiles={caps.canViewFiles} canUploadFiles={caps.canUploadFiles} registerCardCloseActions={reg} requestClose={close} onClose={close} />
        );
      case 'employee':
        return (
          <EmployeeDetailsPage key={k} employeeId={id} canEdit={caps.canManageEmployees} canViewFiles={caps.canViewFiles} canUploadFiles={caps.canUploadFiles} canManageUsers={caps.canManageUsers} onAccessChanged={triggerEmployeesRefresh} me={authStatus.user} registerCardCloseActions={reg} requestClose={close} onOpenEmployee={openEmployee} onOpenCounterparty={openCounterparty} onOpenContract={openContract} onOpenByCode={openByCode} onClose={close} />
        );
      case 'product':
        return (
          <SimpleMasterdataDetailsPage key={k} title="Карточка товара" entityId={id} ownerType="product" typeCode="product" canEdit={caps.canEditMasterData} canViewFiles={caps.canViewFiles} canUploadFiles={caps.canUploadFiles} registerCardCloseActions={reg} requestClose={close} onOpenCustomer={openCounterparty} onClose={close} />
        );
      case 'service':
        return (
          <SimpleMasterdataDetailsPage key={k} title="Карточка услуги" entityId={id} ownerType="service" typeCode="service" canEdit={caps.canEditMasterData} canViewFiles={caps.canViewFiles} canUploadFiles={caps.canUploadFiles} registerCardCloseActions={reg} requestClose={close} onOpenCustomer={openCounterparty} onClose={close} />
        );
      case 'nomenclature_item':
        return (
          <NomenclatureDetailsPage key={k} id={id} canEdit={caps.canEditMasterData} canViewFiles={caps.canViewFiles} canUploadFiles={caps.canUploadFiles} onOpenCustomer={openCounterparty} onOpenContract={openContract} onOpenEngineBrand={openEngineBrand} onOpenByCode={openByCode} onClose={close} />
        );
      case 'tool':
        return (
          <ToolDetailsPage key={k} toolId={id} canEdit={caps.canEditMasterData} canCreateEmployees={caps.canManageEmployees} canViewFiles={caps.canViewFiles} canUploadFiles={caps.canUploadFiles} registerCardCloseActions={reg} requestClose={close} onOpenToolProperty={openToolProperty} onOpenEmployee={openEmployee} onBack={close} />
        );
      case 'tool_property':
        return (
          <ToolPropertyDetailsPage key={k} id={id} canEdit={caps.canEditMasterData} registerCardCloseActions={reg} requestClose={close} onBack={close} />
        );
      case 'engine_assembly_bom_item':
        return <EngineAssemblyBomDetailsPage key={k} id={id} canEdit={caps.canEditMasterData} onClose={close} />;
      case 'stock_document':
        return <StockDocumentDetailsPage key={k} id={id} canEdit={caps.canEditOperations} canCreateParts={caps.canCreateParts} onClose={close} />;
      case 'report_preset':
        return <ReportPresetPage key={k} presetId={id as ReportPresetId} canExport={caps.canExportReports} userId={authStatus.user?.id ?? ''} onBack={close} onOpenWorkOrder={openWorkOrder} onOpenSupplyRequest={(x: string, payload: unknown) => void openRequest(x, { initialPayload: payload as SupplyRequestPayload })} />;
      default:
        return <div style={{ padding: 16, color: 'var(--muted)' }}>Этот вид карточки нельзя открыть во второй панели.</div>;
    }
  }

  // V2 shell reuses the same page chain: render the content of an arbitrary tab id.
  // v1 passes the single `tab`; v2 calls this separately for the lists column and the
  // workspace column. Body = the original {tab === 'x' && ...} chain with tab -> t.
  const renderTabContent = (t: TabId): React.ReactNode => (
    <>

        {t === 'history' && authStatus.loggedIn && (
          <HistoryPage
            meUserId={authStatus.user?.id ?? ''}
            recentVisits={recentVisits}
            quickStartRatings={quickStartRatings}
            pinnedShortcuts={pinnedShortcuts}
            onRemoveShortcut={removePinnedShortcut}
            onNavigate={(link: ChatDeepLinkPayload) => {
              void navigateDeepLink(link);
            }}
            onOpenNotes={(noteId?: string | null) => openNoteFromHistory(noteId)}
            onOpenChat={() => openChatFromHistory()}
          />
        )}

        {t === 'engines' && (
          <EnginesPage
            engines={engines}
            onRefresh={refreshEngines}
            onOpen={openEngine}
            onOpenReport={() => openReportPreset('engines_list')}
            onOpenContractsReport={() => openReportPreset('engines_contracts_overview')}
            onCreate={async () => {
              try {
                const r = await window.matrica.engines.create();
                await refreshEngines();
                await openEngine(r.id);
              } catch (e) {
                const message = String(e ?? '');
                setPostLoginSyncMsg(`Ошибка создания двигателя: ${message}`);
                setTimeout(() => setPostLoginSyncMsg(''), 12_000);
              }
            }}
            canCreate={caps.canEditEngines}
            {...(caps.canCreateWorkOrders
              ? {
                  onCreateAssemblyOrder: (engine: EngineListItem) => {
                    // Тема D: deferred-create сборочного наряда для двигателя из ПКМ-меню
                    // (backend не трогаем — строка/номер материализуются на первом сохранении).
                    void (async () => {
                      try {
                        const r = await window.matrica.workOrders.create();
                        if (!r.ok) {
                          setPostLoginSyncMsg(`Ошибка создания наряда: ${r.error}`);
                          setTimeout(() => setPostLoginSyncMsg(''), 12_000);
                          return;
                        }
                        await openWorkOrder(r.id, {
                          initialPayload: { ...r.payload, workOrderKind: WorkOrderKind.Assembly, assemblyEngineId: engine.id },
                        });
                      } catch (e) {
                        setPostLoginSyncMsg(`Ошибка создания наряда: ${String(e ?? '')}`);
                        setTimeout(() => setPostLoginSyncMsg(''), 12_000);
                      }
                    })();
                  },
                }
              : {})}
          />
        )}

        {t === 'engine_brands' && (
          <EngineBrandsPage
            onOpen={openEngineBrand}
            canCreate={caps.canEditMasterData}
            canViewMasterData={caps.canViewMasterData}
          />
        )}

        {t === 'engine_brand_groups' && (
          <EngineBrandGroupsPage
            onOpen={openEngineBrandGroup}
            canCreate={caps.canEditMasterData}
            canViewMasterData={caps.canViewMasterData}
          />
        )}

        {t === 'engine_brand_group' && selectedEngineBrandGroupId && (
          <EngineBrandGroupDetailsPage
            key={cardKey(selectedEngineBrandGroupId)}
            groupId={selectedEngineBrandGroupId}
            canEdit={caps.canEditMasterData}
            canViewMasterData={caps.canViewMasterData}
            onClose={() => {
              setSelectedEngineBrandGroupId(null);
              setTabState('engine_brand_groups');
            }}
          />
        )}

        {t === 'workshops' && (
          <MasterdataWorkshopsPage
            canManage={caps.canManageWorkshops}
            canEditRepairTemplates={caps.canEditWorkshopRepairTemplates}
          />
        )}

        {t === 'warehouses_admin' && (
          <WarehouseLocationsAdminPage
            canManage={caps.canManageWarehouseLocations}
            onOpenWorkshops={() => setTab('workshops')}
          />
        )}

        {t === 'warehouse_locations' && (
          <WarehouseLocationsPage
            onOpenReport={(presetId: string) =>
              setTab(presetId === 'part_movement_journal' ? 'reports' : t)
            }
          />
        )}

        {t === 'contracts' && (
          <ContractsPage
            onOpen={openContract}
            canCreate={caps.canEditContracts}
            canDelete={caps.canEditContracts}
          />
        )}

        {t === 'counterparties' && (
          <CounterpartiesPage
            onOpen={openCounterparty}
            canCreate={caps.canEditContracts}
            canDelete={caps.canEditContracts}
            canViewMasterData={caps.canViewMasterData}
          />
        )}

        {t === 'requests' && (
          <SupplyRequestsPage
            onOpen={openRequest}
            canCreate={caps.canCreateSupplyRequests}
          />
        )}

        {t === 'work_orders' && (
          <WorkOrdersPage
            onOpen={openWorkOrder}
            canCreate={caps.canCreateWorkOrders}
            canDelete={caps.canEditWorkOrders}
            onOpenReport={() => openReportPreset('work_orders_report')}
          />
        )}

        {t === 'work_order_templates' && (
          <WorkOrderTemplatesPage canEdit={caps.canEditWorkOrderTemplates} />
        )}

        {t === 'services' && (
          <ServicesPage
            onOpen={(id: string) => openService(id, { from: 'services' })}
            onOpenNomenclatureCatalog={() => setTab('nomenclature')}
            onCreateDeferred={() => void openService(crypto.randomUUID(), { from: 'services' })}
            canCreate={caps.canEditMasterData}
            canDelete={caps.canEditMasterData}
            canViewMasterData={caps.canViewMasterData}
          />
        )}

        {t === 'services_by_brand' && (
          <ServicesByBrandPage
            canEdit={caps.canEditMasterData}
            canView={caps.canViewMasterData}
            onOpenService={(id: string) => openService(id, { from: 'services_by_brand' })}
          />
        )}

        {t === 'engine' && selectedEngineId && engineDetails && (
          <EngineDetailsPage
            key={cardKey(selectedEngineId)}
            engineId={selectedEngineId}
            engine={engineDetails}
            onReload={reloadEngine}
            onEngineUpdated={async () => {
              await refreshEngines();
              await reloadEngine();
            }}
            canEditEngines={caps.canEditEngines}
            currentUserId={String(authStatus.user?.id ?? '')}
            currentUserRole={userRole}
            canViewOperations={caps.canViewOperations}
            canEditOperations={caps.canEditOperations}
            canPrintEngineCard={caps.canPrintReports}
            canViewMasterData={caps.canViewMasterData}
            canEditMasterData={caps.canEditMasterData}
            canExportReports={caps.canExportReports}
            canViewFiles={caps.canViewFiles}
            canUploadFiles={caps.canUploadFiles}
            canConfirmEngineDisassemble={caps.canConfirmEngineDisassemble}
            canAssemblyReturn={caps.canAssemblyReturn}
            currentUserProfile={currentUserProfile ? { fullName: currentUserProfile.fullName, position: currentUserProfile.position } : null}
            registerCardCloseActions={registerCardCloseActions}
            requestClose={requestCardClose}
            onOpenEngine={(id: string) => void openEngine(id)}
            onOpenEngineReclamation={(id: string) => void openEngine(id, { initialTab: 'reclamation' })}
            initialTab={engineInitialTab}
            onOpenEngineBrand={openEngineBrand}
            onOpenCounterparty={openCounterparty}
            onOpenContract={openContract}
            onOpenSupplyRequest={openRequest}
            canCreateSupplyRequest={caps.canCreateSupplyRequests && caps.canEditSupplyRequests}
            canCreateWorkOrder={caps.canCreateWorkOrders}
            onOpenWorkOrder={(id: string) => void openWorkOrder(id)}
            onClose={() => {
              setSelectedEngineId(null);
              setEngineDetails(null);
              setTabState('engines');
              void refreshEngines();
            }}
          />
      )}

        {t === 'engine_brand' && selectedEngineBrandId && (
          <EngineBrandDetailsPage
            key={cardKey(selectedEngineBrandId)}
            brandId={selectedEngineBrandId}
            canEdit={caps.canEditMasterData}
            canViewParts={caps.canViewParts}
            canCreateParts={caps.canCreateParts}
            canEditParts={caps.canEditParts}
            canViewMasterData={caps.canViewMasterData}
            onOpenPart={openPart}
            canViewFiles={caps.canViewFiles}
            canUploadFiles={caps.canUploadFiles}
            registerCardCloseActions={registerCardCloseActions}
            requestClose={requestCardClose}
            onClose={() => {
              setSelectedEngineBrandId(null);
              setTabState('engine_brands');
            }}
          />
        )}
        {t === 'engine' && selectedEngineId && !engineDetails && (
          <div style={{ padding: 16, border: '1px solid #e5e7eb', borderRadius: 12 }}>
            <div style={{ fontWeight: 600, marginBottom: 6 }}>Карточка двигателя</div>
            <div style={{ color: '#6b7280', marginBottom: 12 }}>
              {engineLoading ? 'Загрузка...' : engineOpenError || 'Нет данных для отображения.'}
            </div>
            <Button onClick={() => setTab('engines')}>Вернуться к списку</Button>
          </div>
        )}

        {t === 'request' && selectedRequestId && (
          <SupplyRequestDetailsPage
            key={cardKey(selectedRequestId)}
            id={selectedRequestId}
            {...(newRequestSeed && newRequestSeed.id === selectedRequestId ? { initialPayload: newRequestSeed.payload } : {})}
            canEdit={caps.canEditSupplyRequests}
            canSign={caps.canSignSupplyRequests}
            canApprove={caps.canApproveSupplyRequests}
            canAccept={caps.canAcceptSupplyRequests}
            canFulfill={caps.canFulfillSupplyRequests}
            canPrint={caps.canPrintSupplyRequests}
            canViewMasterData={caps.canViewMasterData}
            canEditMasterData={caps.canEditMasterData}
            canViewFiles={caps.canViewFiles}
            canUploadFiles={caps.canUploadFiles}
            userPosition={currentUserProfile?.position ?? null}
            userRole={authStatus.user?.role ?? null}
            userDepartmentId={currentUserProfile?.sectionId ?? null}
            registerCardCloseActions={registerCardCloseActions}
            requestClose={requestCardClose}
            onOpenProduct={openProduct}
            onOpenService={openService}
            onOpenNomenclature={openNomenclature}
            onOpenStockDocument={openStockDocument}
            onOpenPart={openPart}
            onClose={() => {
              setSelectedRequestId(null);
              setTabState('requests');
            }}
          />
        )}

        {t === 'work_order' && selectedWorkOrderId && (
          <WorkOrderDetailsPage
            key={cardKey(selectedWorkOrderId)}
            id={selectedWorkOrderId}
            {...(newWorkOrderSeed && newWorkOrderSeed.id === selectedWorkOrderId ? { initialPayload: newWorkOrderSeed.payload } : {})}
            canEdit={caps.canEditWorkOrders}
            canEditMasterData={caps.canEditMasterData}
            canCreateParts={caps.canCreateParts}
            canCreateEmployees={caps.canManageEmployees}
            canCloseWorkOrders={caps.canCloseWorkOrders}
            canEditWorkshopRepairTemplates={caps.canEditWorkshopRepairTemplates}
            canEditWorkOrderTemplates={caps.canEditWorkOrderTemplates}
            registerCardCloseActions={registerCardCloseActions}
            requestClose={requestCardClose}
            onOpenPart={openPart}
            onOpenService={openService}
            onOpenEmployee={openEmployee}
            onClose={() => {
              setSelectedWorkOrderId(null);
              setTabState('work_orders');
            }}
          />
        )}

        {t === 'parts' && (
          <PartsPage
            onOpen={openPart}
            onOpenNomenclatureCatalog={() => setTab('nomenclature')}
            canCreate={caps.canCreateParts}
            canDelete={caps.canDeleteParts}
          />
        )}

        {t === 'tools' && (
          <ToolsPage
            onOpen={openNomenclature}
            onOpenNomenclatureCatalog={() => setTab('nomenclature')}
            onOpenProperties={() => setTab('tool_properties')}
            canCreate={caps.canEditMasterData}
            canDelete={caps.canEditMasterData}
          />
        )}

        {t === 'tool_accounting' && (
          <SupplyToolMovementsPage
            canEdit={caps.canEditMasterData || caps.canFulfillSupplyRequests}
            canViewMasterData={caps.canViewMasterData}
            onOpenNomenclature={openNomenclature}
            onOpenEmployee={(id: string) => void openEmployee(id)}
            canCreateEmployees={caps.canManageEmployees}
          />
        )}

        {t === 'tool_properties' && (
          <ToolPropertiesPage
            onOpen={openToolProperty}
            canCreate={caps.canEditMasterData}
            canDelete={caps.canEditMasterData}
          />
        )}

        {t === 'employees' && (
          <EmployeesPage
            onOpen={(id: string) => openEmployee(id)}
            canCreate={caps.canManageEmployees}
            canDelete={caps.canManageEmployees}
            refreshKey={employeesRefreshKey}
          />
        )}

        {t === 'timesheets' && (
          <TimesheetsPage
            canEdit={caps.canEditTimesheets}
            onOpen={(id: string) => {
              setSelectedTimesheetId(id);
              setTab('timesheet');
            }}
          />
        )}

        {t === 'timesheet' && selectedTimesheetId && (
          <TimesheetGridPage
            key={selectedTimesheetId}
            timesheetId={selectedTimesheetId}
            canEdit={caps.canEditTimesheets}
            onBack={() => {
              setSelectedTimesheetId(null);
              setTab('timesheets');
            }}
          />
        )}

        {t === 'nomenclature' && (
          <NomenclaturePage
            onOpen={openNomenclature}
            canEdit={caps.canEditMasterData}
          />
        )}

        {t === 'parts_dedupe' && (
          <PartsDedupePage canEdit={caps.canEditMasterData} />
        )}

        {t === 'empty_cards' && (
          <EmptyCardsCleanupPage canEdit={caps.canEditMasterData} />
        )}

        {t === 'drafts' && (
          <DraftsPage
            onOpenWorkOrder={openWorkOrder}
            onOpenSupplyRequest={openRequest}
            onOpenProduct={openProduct}
            onOpenService={openService}
            onOpenCounterparty={openCounterparty}
            onOpenEngineBrand={openEngineBrand}
            onOpenContract={openContract}
            onOpenEngine={openEngine}
            onOpenEmployee={openEmployee}
          />
        )}

        {t === 'engine_assembly_bom' && (
          <EngineAssemblyBomPage
            canEdit={caps.canEditMasterData}
            onOpen={openEngineAssemblyBom}
          />
        )}

        {(t === 'stock_receipts' || t === 'stock_issues' || t === 'stock_transfers' || t === 'stock_documents') && (
          <StockDocumentsPage
            defaultDocType={
              t === 'stock_receipts'
                ? 'stock_receipt'
                : t === 'stock_issues'
                  ? 'stock_issue'
                  : t === 'stock_transfers'
                    ? 'stock_transfer'
                    : undefined
            }
            canEdit={caps.canEditOperations}
            onOpen={(id: string) =>
              void openStockDocument(
                id,
                t === 'stock_receipts' || t === 'stock_issues' || t === 'stock_transfers' ? t : 'stock_documents',
              )
            }
          />
        )}

        {t === 'stock_balances' && (
          <StockBalancesPage
            onOpenDocument={(id: string) => void openStockDocument(id, 'stock_documents')}
            onOpenNomenclature={openNomenclature}
            onOpenSupplyRequest={openRequest}
            canCreateSupplyRequest={caps.canCreateSupplyRequests && caps.canEditSupplyRequests}
          />
        )}

        {t === 'stock_inventory' && (
          <StockInventoryPage
            canEdit={caps.canEditOperations}
            onOpenDocument={(id: string) => void openStockDocument(id, 'stock_inventory')}
          />
        )}

        {t === 'repair_fund_audit' && (
          <RepairFundAuditPage
            canEdit={caps.canEditOperations}
            onOpenDocument={(id: string) => void openStockDocument(id, 'stock_documents')}
          />
        )}

        {t === 'warehouse_analytics' && <WarehouseAnalyticsPage />}

        {t === 'workshop_stats' && <WorkshopStatsPage />}
        {t === 'custom_reports' && <CustomReportsPage />}

        {t === 'access_sections' && <AccessSectionsPage onOpenEmployee={openEmployee} />}

        {t === 'tool' && selectedToolId && (
          <ToolDetailsPage
            key={cardKey(selectedToolId)}
            toolId={selectedToolId}
            canEdit={caps.canEditMasterData}
            canCreateEmployees={caps.canManageEmployees}
            canViewFiles={caps.canViewFiles}
            canUploadFiles={caps.canUploadFiles}
            registerCardCloseActions={registerCardCloseActions}
            requestClose={requestCardClose}
            onOpenToolProperty={openToolProperty}
            onOpenEmployee={openEmployee}
            onBack={() => {
              setSelectedToolId(null);
              setTabState('tools');
            }}
          />
        )}

        {t === 'tool_property' && selectedToolPropertyId && (
          <ToolPropertyDetailsPage
            key={cardKey(selectedToolPropertyId)}
            id={selectedToolPropertyId}
            canEdit={caps.canEditMasterData}
            registerCardCloseActions={registerCardCloseActions}
            requestClose={requestCardClose}
            onBack={() => {
              setSelectedToolPropertyId(null);
              setTabState('tool_properties');
            }}
          />
        )}

        {t === 'contract' && selectedContractId && (
          <ContractDetailsPage
            key={cardKey(selectedContractId)}
            contractId={selectedContractId}
            canEdit={caps.canEditContracts}
            canEditMasterData={caps.canEditMasterData}
            canViewFiles={caps.canViewFiles}
            canUploadFiles={caps.canUploadFiles}
            registerCardCloseActions={registerCardCloseActions}
            requestClose={requestCardClose}
            onClose={() => {
              setSelectedContractId(null);
              setTabState('contracts');
            }}
            onOpenCounterparty={openCounterparty}
            onOpenEngine={openEngine}
            onOpenPart={openPart}
            onOpenEngineBrand={openEngineBrand}
          />
        )}

        {t === 'counterparty' && selectedCounterpartyId && (
          <CounterpartyDetailsPage
            key={cardKey(selectedCounterpartyId)}
            counterpartyId={selectedCounterpartyId}
            canEdit={caps.canEditContracts}
            canViewFiles={caps.canViewFiles}
            canUploadFiles={caps.canUploadFiles}
            registerCardCloseActions={registerCardCloseActions}
            requestClose={requestCardClose}
            onClose={() => {
              setSelectedCounterpartyId(null);
              setTabState('counterparties');
            }}
          />
        )}

        {t === 'employee' && selectedEmployeeId && (
          <EmployeeDetailsPage
            key={cardKey(selectedEmployeeId)}
            employeeId={selectedEmployeeId}
            canEdit={caps.canManageEmployees}
            canViewFiles={caps.canViewFiles}
            canUploadFiles={caps.canUploadFiles}
            canManageUsers={caps.canManageUsers}
            onAccessChanged={triggerEmployeesRefresh}
            me={authStatus.user}
            registerCardCloseActions={registerCardCloseActions}
            requestClose={requestCardClose}
            onOpenEmployee={openEmployee}
            onOpenCounterparty={openCounterparty}
            onOpenContract={openContract}
            onOpenByCode={openByCode}
            onClose={() => {
              setSelectedEmployeeId(null);
              setTabState('employees');
            }}
          />
        )}

        {t === 'product' && selectedProductId && (
          <SimpleMasterdataDetailsPage
            key={cardKey(selectedProductId)}
            title="Карточка товара"
            entityId={selectedProductId}
            ownerType="product"
            typeCode="product"
            nomenclaturePreset={{ directoryKind: PRODUCTS_PRESET.directoryKind, createConfig: PRODUCTS_PRESET.createConfig }}
            canEdit={caps.canEditMasterData}
            canViewFiles={caps.canViewFiles}
            canUploadFiles={caps.canUploadFiles}
            registerCardCloseActions={registerCardCloseActions}
            requestClose={requestCardClose}
            onOpenCustomer={openCounterparty}
            onClose={() => {
              setSelectedProductId(null);
              setTabState('nomenclature');
            }}
          />
        )}

        {t === 'service' && selectedServiceId && (
          <SimpleMasterdataDetailsPage
            key={cardKey(selectedServiceId)}
            title="Карточка услуги"
            entityId={selectedServiceId}
            ownerType="service"
            typeCode="service"
            nomenclaturePreset={{ directoryKind: SERVICES_PRESET.directoryKind, createConfig: SERVICES_PRESET.createConfig }}
            canEdit={caps.canEditMasterData}
            canViewFiles={caps.canViewFiles}
            canUploadFiles={caps.canUploadFiles}
            registerCardCloseActions={registerCardCloseActions}
            requestClose={requestCardClose}
            onOpenCustomer={openCounterparty}
            onClose={() => {
              const back = serviceOriginTab ?? 'nomenclature';
              setSelectedServiceId(null);
    setServiceOriginTab(null);
              setServiceOriginTab(null);
              setTabState(back);
            }}
          />
        )}

        {t === 'nomenclature_item' && selectedNomenclatureId && (
          <NomenclatureDetailsPage
            key={cardKey(selectedNomenclatureId)}
            id={selectedNomenclatureId}
            canEdit={caps.canEditMasterData}
            canViewFiles={caps.canViewFiles}
            canUploadFiles={caps.canUploadFiles}
            onOpenCustomer={openCounterparty}
            onOpenContract={openContract}
            onOpenEngineBrand={openEngineBrand}
            onOpenByCode={openByCode}
            onClose={() => {
              const back = nomenclatureOriginTab ?? 'nomenclature';
              setSelectedNomenclatureId(null);
              setNomenclatureOriginTab(null);
              setTabState(back);
            }}
          />
        )}

        {t === 'engine_assembly_bom_item' && selectedEngineAssemblyBomId && (
          <EngineAssemblyBomDetailsPage
            key={cardKey(selectedEngineAssemblyBomId)}
            id={selectedEngineAssemblyBomId}
            canEdit={caps.canEditMasterData}
            onClose={() => {
              setSelectedEngineAssemblyBomId(null);
              setTabState('engine_assembly_bom');
            }}
          />
        )}

        {t === 'stock_document' && selectedStockDocumentId && (
          <StockDocumentDetailsPage
            key={cardKey(selectedStockDocumentId)}
            id={selectedStockDocumentId}
            canEdit={caps.canEditOperations}
            canCreateParts={caps.canCreateParts}
            onClose={() => {
              setSelectedStockDocumentId(null);
              setTabState(stockDocumentParentTab);
            }}
          />
        )}

        {t === 'changes' && authStatus.loggedIn && authStatus.user && (
          <ChangesPage
            me={authStatus.user}
            canDecideAsAdmin={['admin', 'superadmin'].includes(String(authStatus.user.role ?? '').toLowerCase())}
          />
        )}

        {t === 'notes' && (
          <NotesPage
            meUserId={authStatus.user?.id ?? ''}
            canEdit={authStatus.loggedIn && !viewMode}
            initialNoteId={historyInitialNoteId}
            onNavigate={(link: ChatDeepLinkPayload) => {
              void navigateDeepLink(link);
            }}
            onSendToChat={sendNoteToChat}
            onBurningCountChange={(count: number) => setNotesAlertCount(count)}
          />
        )}

        {t === 'settings' && (
          <SettingsPage
            uiPrefs={uiPrefs}
            onUiPrefsChange={setUiPrefs}
            onLogout={() => {
              void window.matrica.auth.status().then(setAuthStatus).catch(() => {});
              setTab('auth');
            }}
          />
        )}

        {t === 'user_screens' && (
          <UserScreensPage onOpen={(id: string) => openUserScreen(id)} onEdit={(id: string | null) => editUserScreen(id)} />
        )}
        {t === 'user_screen' && selectedUserScreenId && (
          userScreenEditMode ? (
            <ScreenEditorPage
              screenId={selectedUserScreenId === 'new' ? null : selectedUserScreenId}
              tabOptions={sectionGatedTabs.map((id) => ({ id, label: MENU_TAB_LABELS[id] }))}
              onSaved={(id: string) => setSelectedUserScreenId(id)}
              onDeleted={() => {
                setSelectedUserScreenId(null);
                requestTabSwitch('user_screens');
              }}
            />
          ) : (
            <UserScreenViewPage
              screenId={selectedUserScreenId}
              onEdit={(id: string) => editUserScreen(id)}
              onNavigateTab={(tabId: string) => {
                if ((sectionGatedTabs as string[]).includes(tabId)) setTab(tabId as TabId);
              }}
            />
          )
        )}

        {t === 'reports' && (
          <ReportsCatalogPage
            userId={authStatus.user?.id ?? ''}
            onOpenPreset={(presetId: ReportPresetId) => openReportPreset(presetId)}
            pinnedShortcuts={pinnedShortcuts}
            onAddShortcut={addPinnedShortcut}
            onRemoveShortcut={removePinnedShortcut}
          />
        )}
        {t === 'report_preset' && selectedReportPresetId && (
          <ReportPresetPage
            presetId={selectedReportPresetId}
            canExport={caps.canExportReports}
            userId={authStatus.user?.id ?? ''}
            onBack={() => setTab('reports')}
            onOpenWorkOrder={openWorkOrder}
            onOpenSupplyRequest={(id: string, payload: unknown) => void openRequest(id, { initialPayload: payload as SupplyRequestPayload })}
          />
        )}

        {t === 'masterdata' && (
          <MasterdataPage
            canViewMasterData={caps.canViewMasterData}
            canEditMasterData={caps.canEditMasterData}
            userRole={userRole}
          />
        )}

        {t === 'audit' && String(authStatus.user?.role ?? '').toLowerCase() === 'superadmin' && <SuperadminAuditPage />}

        {t === 'admin' && <div style={{ color: 'var(--muted)' }}>Раздел перемещён в карточку сотрудника.</div>}

        {t === 'auth' && (
          <AuthPage
            onChanged={(s: AuthStatus) => {
              setAuthStatus(s);
              if (s.loggedIn) setTab('history');
            }}
          />
        )}


        {t === 'engine' && (!selectedEngineId || !engineDetails) && (
          <div style={{ color: 'var(--muted)' }}>Выберите двигатель из списка.</div>
      )}

        {t === 'contract' && !selectedContractId && (
          <div style={{ color: 'var(--muted)' }}>Выберите контракт из списка.</div>
        )}

        {t === 'counterparty' && !selectedCounterpartyId && (
          <div style={{ color: 'var(--muted)' }}>Выберите контрагента из списка.</div>
        )}

        {t === 'request' && !selectedRequestId && (
          <div style={{ color: 'var(--muted)' }}>Выберите заявку из списка.</div>
        )}

        {t === 'work_order' && !selectedWorkOrderId && (
          <div style={{ color: 'var(--muted)' }}>Выберите наряд из списка.</div>
        )}

        {t === 'employee' && !selectedEmployeeId && (
          <div style={{ color: 'var(--muted)' }}>Выберите сотрудника из списка.</div>
        )}

        {t === 'product' && !selectedProductId && (
          <div style={{ color: 'var(--muted)' }}>Выберите товар из списка.</div>
        )}

        {t === 'service' && !selectedServiceId && (
          <div style={{ color: 'var(--muted)' }}>Выберите услугу из списка.</div>
        )}

        {t === 'nomenclature_item' && !selectedNomenclatureId && (
          <div style={{ color: 'var(--muted)' }}>Выберите номенклатуру из списка.</div>
        )}

        {t === 'engine_assembly_bom_item' && !selectedEngineAssemblyBomId && (
          <div style={{ color: 'var(--muted)' }}>Выберите BOM-спецификацию из списка.</div>
        )}

        {t === 'stock_document' && !selectedStockDocumentId && (
          <div style={{ color: 'var(--muted)' }}>Выберите складской документ из списка.</div>
        )}
        {t === 'report_preset' && !selectedReportPresetId && (
          <div style={{ color: 'var(--muted)' }}>Выберите шаблон отчёта из каталога.</div>
        )}
    </>
  );

  return (
    <ErrorBoundary onError={(error, info) => recordFatalError(error, info)}>
      <Page
        title={pageTitle}
        uiTheme={resolvedTheme}
        center={headerStatus}
        right={
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', justifyContent: 'flex-end' }}>
          {/* Крупная кнопка режима «Комп/Планшет» (Ф1a). Появляется ТОЛЬКО когда машина помечена
              планшетом (Настройки → «Это планшет»), на всех страницах обеих оболочек. Палец-таргет
              ~48px. На обычном ПК кнопки нет вовсе. */}
          {authStatus.loggedIn && isTabletDevice && (
            <Button
              variant={isTabletUi ? 'primary' : 'ghost'}
              onClick={() => toggleUiMode()}
              title={isTabletUi
                ? 'Планшетный режим включён (крупные элементы для пальца). Нажмите для режима компьютера.'
                : 'Режим компьютера (обычные размеры). Нажмите для планшетного режима.'}
              aria-label={isTabletUi ? 'Режим: Планшет' : 'Режим: Комп'}
              style={{ minHeight: 48, padding: '10px 18px', fontSize: 16, fontWeight: 600 }}
            >
              {isTabletUi ? '📱 Планшет' : '💻 Комп'}
            </Button>
          )}
          {/* Переключатель темы интерфейса — всегда виден в верхней панели (в т.ч. до входа).
              Тема глобальная и применяется мгновенно; выбранная подсвечивается primary. */}
          <div style={{ display: 'flex', gap: 4, alignItems: 'center' }} title="Тема интерфейса">
            {([
              { key: 'auto', icon: '🌗', label: 'Авто (по системе)' },
              { key: 'light', icon: '☀️', label: 'Светлая' },
              { key: 'dark', icon: '🌙', label: 'Тёмная' },
              { key: 'warm', icon: '🔥', label: 'Тёплая (цеховая)' },
            ] as const).map((o) => (
              <Button
                key={o.key}
                size="sm"
                variant={uiPrefs.theme === o.key ? 'primary' : 'ghost'}
                title={`Тема: ${o.label}`}
                aria-label={`Тема: ${o.label}`}
                onClick={() => void persistTheme(o.key)}
              >
                {o.icon}
              </Button>
            ))}
          </div>
          {/* Переключатель интерфейсов — всегда на виду в шапке (после входа), в обеих
              оболочках. Дефолт — «Резиновый» (v2); возврат на старый в один клик,
              выбор запоминается per-user и переживает обновления. */}
          {authStatus.loggedIn && (
            <Button
              size="sm"
              variant={isV2 ? 'primary' : 'ghost'}
              onClick={() => switchShellVersion(isV2 ? 'v1' : 'v2')}
              title={isV2 ? 'Вернуться к старому интерфейсу' : 'Включить интерфейс «Резиновый»'}
              aria-label={isV2 ? 'Старый интерфейс' : 'Интерфейс «Резиновый»'}
            >
              {isV2 ? '↩️ Старый интерфейс' : '🧩 Интерфейс «Резиновый»'}
            </Button>
          )}
          {authStatus.loggedIn && (
            <Button variant="ghost" onClick={() => setGlobalSearchOpen(true)} title="Глобальный поиск (Ctrl+K)">
              🔍 Поиск
            </Button>
          )}
          {authStatus.loggedIn && (
            <div ref={trashButtonRef} style={{ position: 'relative' }}>
              <Button
                variant="ghost"
                onClick={() => setTrashOpen((prev) => !prev)}
                title="Корзина кнопок"
              >
                🗑 Корзина
              </Button>
              {trashOpen && (
                <div
                  ref={trashPopupRef}
                  style={{
                    position: 'absolute',
                    top: 'calc(100% + 6px)',
                    right: 0,
                    background: 'var(--surface)',
                    border: '1px solid var(--border)',
                    borderRadius: 10,
                    boxShadow: '0 16px 40px rgba(15,23,42,0.18)',
                    padding: 8,
                    zIndex: 1900,
                    minWidth: 220,
                    maxWidth: 320,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                    <div style={{ fontWeight: 700 }}>Скрытые кнопки</div>
                    <Button variant="ghost" onClick={restoreAllHiddenTabs} disabled={menuState.hidden.length === 0}>
                      Восстановить
                    </Button>
                  </div>
                  {menuState.hiddenVisible.length === 0 ? (
                    <div style={{ color: 'var(--muted)' }}>Нет скрытых кнопок</div>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      {menuState.hiddenVisible.map((id) => (
                        <Button
                          key={id}
                          variant="ghost"
                          onClick={() => {
                            restoreHiddenTab(id);
                          }}
                        >
                          {menuLabels[id] ?? id}
                        </Button>
                      ))}
                    </div>
                  )}
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 10, marginBottom: 6 }}>
                    <div style={{ fontWeight: 700 }}>Скрытые отделы</div>
                    <Button variant="ghost" onClick={restoreAllHiddenGroups} disabled={menuState.hiddenGroups.length === 0}>
                      Восстановить
                    </Button>
                  </div>
                  {menuState.hiddenGroupsVisible.length === 0 ? (
                    <div style={{ color: 'var(--muted)' }}>Нет скрытых отделов</div>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      {menuState.hiddenGroupsVisible.map((id) => (
                        <Button
                          key={`group-${id}`}
                          variant="ghost"
                          onClick={() => {
                            restoreHiddenGroup(id);
                          }}
                        >
                          {GROUP_LABELS[id] ?? id}
                        </Button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
          {authStatus.loggedIn && !viewMode && (
            <>
              <ListColumnsToggle isMultiColumn={isMultiColumn} onToggle={toggleListColumnsMode} />
              <Button
                variant="ghost"
                onClick={() => void sendCurrentPositionToChat()}
                title="Отправить ссылку на текущий раздел в чат"
              >
                Ссылку в чат
              </Button>
              <Button
                variant="ghost"
                onClick={() => void saveCurrentPositionToNotes()}
                title="Сохранить ссылку на текущий раздел в заметки"
              >
                Ссылку в заметки
              </Button>
            </>
          )}
          {authStatus.loggedIn && caps.canUseSync && !viewMode && (
            <Button
              variant="ghost"
                onClick={() => void runSyncNow()}
              disabled={syncStatus?.state === 'syncing'}
              title="Запустить синхронизацию вручную"
              aria-label="Синхронизировать сейчас"
              style={{
                background: '#90ee90',
                color: '#000000',
                border: '1px solid #4b8a4b',
                boxShadow: 'none',
                fontWeight: 700,
                width: 28,
                height: 28,
                minWidth: 28,
                minHeight: 28,
                padding: 0,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 16,
                lineHeight: 1,
              }}
            >
              ↻
            </Button>
          )}
          <Button
            variant="ghost"
            onClick={(e) => {
              if (!authStatus.loggedIn) {
                setTab(userTab);
                return;
              }
              const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
              setAccountMenuPos({ x: rect.left, y: rect.bottom + 4 });
            }}
            style={{
              border: tab === userTab ? '1px solid #1e40af' : '1px solid rgba(15, 23, 42, 0.22)',
              background: tab === userTab ? '#e2e8f0' : '#f8fafc',
              color: '#0f172a',
              fontWeight: 700,
            }}
          >
            {userLabel?.trim() ? userLabel.trim() : 'Вход'}
          </Button>
        </div>
        }
      >
        {renderReleaseWelcomeModal()}
        {renderFullSyncModal()}
        {renderFatalModal()}
        {renderCardCloseModal()}
        {renderRecoveryModal()}
        {renderAppCloseSyncOverlay()}
        {accountMenuPos && (
          <ListContextMenu
            x={accountMenuPos.x}
            y={accountMenuPos.y}
            onClose={() => setAccountMenuPos(null)}
            items={[
              { id: 'settings', label: '⚙️ Настройки', onClick: () => setTab('settings') },
              {
                id: 'shell',
                label: isV2 ? '🧩 Старый интерфейс' : '🧩 Интерфейс «Резиновый»',
                onClick: () => switchShellVersion(isV2 ? 'v1' : 'v2'),
              },
              { id: 'switch', label: '👥 Смена аккаунта', onClick: () => setAccountSwitchOpen(true) },
              {
                id: 'logout',
                label: '⏻ Выйти',
                danger: true,
                onClick: () => {
                  void (async () => {
                    await window.matrica.auth.logout({}).catch(() => {});
                    const s = await window.matrica.auth.status();
                    setAuthStatus(s);
                    setTab('auth');
                  })();
                },
              },
            ]}
          />
        )}
        <AccountSwitchDialog
          open={accountSwitchOpen}
          currentLogin={authStatus.user?.username ?? ''}
          onClose={() => setAccountSwitchOpen(false)}
          onSwitched={(s) => {
            setAuthStatus(s);
            if (s.loggedIn) setTab('history');
          }}
        />
      <div style={{ position: 'relative', height: '100%', minHeight: 0 }}>
      <div style={{ display: 'flex', gap: 6, height: '100%', minHeight: 0 }}>
        {chatOpen && authStatus.loggedIn && canChat && uiPrefs.chatSide === 'left' && (
          <div
            style={{
              flex: '0 0 25%',
              minWidth: 320,
              borderRight: '1px solid var(--border)',
              overflow: 'hidden',
              height: '100%',
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            <ChatPanel
              meUserId={authStatus.user?.id ?? ''}
              meRole={authStatus.user?.role ?? ''}
              canExport={canChatExport}
              canAdminViewAll={canChatAdminView}
              viewMode={viewMode}
              chatSide="left"
              onHide={() => setChatOpen(false)}
              onToggleSide={() => void persistChatSide('right')}
              onChatContextChange={(ctx) => setChatContext(ctx)}
              onNavigate={(link) => {
                void navigateDeepLink(link);
              }}
            />
          </div>
        )}
        <div
          style={{
            flex: chatOpen && authStatus.loggedIn && canChat ? '0 0 75%' : '1 1 auto',
            minWidth: 0,
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
            paddingRight: 2,
          }}
        >
          {viewMode && (
            <div
              style={{
                marginBottom: 10,
                padding: 10,
                borderRadius: 12,
                border: '1px solid rgba(248, 113, 113, 0.5)',
                background: 'rgba(248, 113, 113, 0.16)',
                color: 'var(--danger)',
                fontWeight: 800,
              }}
            >
              Режим просмотра резервной копии, данные изменять невозможно, только копировать и сохранять в файлы
            </div>
          )}
          {/* Ф2: часть правок не уехала — двигатель занят. Отдельным блоком, а НЕ через
              postLoginSyncMsg: тот рисуется только при матче регекспа на текст ошибки. */}
          {syncStatus?.lastResult?.reservedSkipped ? (
            <div
              style={{
                marginBottom: 10,
                padding: 10,
                borderRadius: 12,
                border: '1px solid #fde68a',
                background: '#fffbeb',
                color: '#b45309',
              }}
            >
              {`Двигатель занят (${syncStatus.lastResult.reservedSkipped.holders.join(', ') || 'другой сотрудник'}): ${syncStatus.lastResult.reservedSkipped.count} изменений пока не приняты — уйдут, когда резерв снимут.`}
            </div>
          ) : null}
          {isV2 ? (
            <V2Shell
              prefs={(shellPrefs ?? DEFAULT_UI_SHELL_PREFS).v2}
              onPrefsChange={updateV2Prefs}
              availableTabs={sectionGatedTabs}
              menuLabels={menuLabels}
              tab={tab}
              activeListTab={v2ActiveListTab}
              onMenuTab={handleMenuTab}
              onCloseListColumn={() => setV2ActiveListTab(null)}
              renderTabContent={renderTabContent}
              onSwitchToV1={() => switchShellVersion('v1')}
              openCards={v2OpenCards}
              focusedCardKey={(() => { const idn = v2CurrentCardIdentity(); return idn ? `${idn.kind}:${idn.entityId}` : null; })()}
              onFocusCard={focusV2Card}
              onCloseCard={closeV2Card}
              secondaryCard={v2SecondaryCard}
              renderSecondaryCard={renderSecondaryCard}
              onSplitCard={openSecondaryCard}
              onCloseSecondary={closeSecondaryCard}
            />
          ) : (
            <>
          <div style={{ flex: '0 0 auto' }}>
            <Tabs
              tab={tab}
              onTab={handleMenuTab}
              availableTabs={sectionGatedTabs}
              layout={tabsLayout}
              onLayoutChange={persistTabsLayout}
              userLabel={userLabel}
              userTab={userTab}
              displayPrefs={uiPrefs.displayPrefs}
              canGoBack={canGoBack}
              canGoForward={canGoForward}
              onBack={goBack}
              onForward={goForward}
              {...(presence ? { authStatus: { online: presence.online } } : {})}
              notesAlertCount={notesAlertCount}
              historyAlertCount={historyAlertCount}
              pinnedShortcuts={pinnedShortcuts}
              onAddShortcut={addPinnedShortcut}
              onRemoveShortcut={removePinnedShortcut}
            />
          </div>

          <div className="ui-content-viewport" style={{ marginTop: 6, flex: '1 1 auto', minHeight: 0, overflow: 'auto' }}>
            {!authStatus.loggedIn && tab !== 'auth' && (
              <div style={{ color: 'var(--muted)' }}>Требуется вход.</div>
            )}

            <React.Suspense
              fallback={
                <div style={{ padding: 16, color: 'var(--muted)' }}>
                  Загрузка раздела...
                </div>
              }
            >
              {renderTabContent(tab)}
            </React.Suspense>
          </div>
            </>
          )}
        </div>

        {chatOpen && authStatus.loggedIn && canChat && uiPrefs.chatSide !== 'left' && (
          <div
            style={{
              flex: '0 0 25%',
              minWidth: 320,
              borderLeft: '1px solid rgba(0,0,0,0.08)',
              overflow: 'hidden',
              height: '100%',
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            <ChatPanel
              meUserId={authStatus.user?.id ?? ''}
              meRole={authStatus.user?.role ?? ''}
              canExport={canChatExport}
              canAdminViewAll={canChatAdminView}
              viewMode={viewMode}
              chatSide="right"
              onHide={() => setChatOpen(false)}
              onToggleSide={() => void persistChatSide('left')}
              onChatContextChange={(ctx) => setChatContext(ctx)}
              onNavigate={(link) => {
                void navigateDeepLink(link);
              }}
            />
          </div>
        )}
      </div>
      {authStatus.loggedIn && canChat && (
        <div
          style={{
            position: 'absolute',
            top: '50%',
            transform: 'translateY(-50%)',
            zIndex: 6,
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
            left: edgeSide === 'left' ? 0 : 'auto',
            right: edgeSide === 'right' ? 0 : 'auto',
          }}
        >
          <Button
            variant="ghost"
            onClick={() => void persistChatSide(edgeSide === 'left' ? 'right' : 'left')}
            title="Переместить чат"
            style={edgeMoveButtonStyle}
          >
            {edgeSide === 'left' ? '→' : '←'}
          </Button>
          {chatOpen ? (
            <Button variant="ghost" onClick={() => setChatOpen(false)} title="Свернуть чат" style={edgeButtonStyle}>
              Свернуть чат
            </Button>
          ) : (
            <Button variant="primary" onClick={() => setChatOpen(true)} title="Открыть чат" style={edgeButtonStyle}>
              {`Открыть чат${chatUnreadTotal > 0 ? ` (${chatUnreadTotal})` : ''}`}
            </Button>
          )}
        </div>
      )}
      </div>

      {canAiAgent && (
        <>
          {aiChatOpen ? (
            <AiAgentChat
              ref={aiChatRef}
              visible={aiChatOpen}
              context={aiContext}
              lastEvent={aiLastEvent}
              recentEvents={aiRecentEvents}
              onClose={() => setAiChatOpen(false)}
            />
          ) : (
            <button
              onClick={() => setAiChatOpen(true)}
              style={{
                position: 'fixed',
                right: 16,
                bottom: 16,
                borderRadius: 999,
                border: '1px solid var(--border)',
                background: 'var(--surface)',
                color: 'var(--text)',
                padding: '8px 14px',
                fontWeight: 700,
                boxShadow: '0 12px 30px rgba(0,0,0,0.2)',
                cursor: 'pointer',
                zIndex: 20,
              }}
              title="Открыть чат ИИ‑агента"
            >
              ИИ‑агент
            </button>
          )}
        </>
      )}
      <GlobalInputAssist storageKey="matrica_client_input_assist_history_v1" />
      <GlobalSearchOverlay
        open={globalSearchOpen}
        onClose={() => setGlobalSearchOpen(false)}
        onSelect={(hit) => {
          setGlobalSearchOpen(false);
          void navigateToRoute(searchHitToRoute(hit));
        }}
        onNavigateTab={(tabId) => {
          void navigateToRoute({ kind: 'tab', id: tabId });
        }}
      />
    </Page>
    </ErrorBoundary>
  );
}


