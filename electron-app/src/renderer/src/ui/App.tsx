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
} from '@matricarmz/shared';
import {
  DEFAULT_UI_CONTROL_SETTINGS,
  DEFAULT_UI_DISPLAY_PREFS,
  DEFAULT_UI_PRESET_ID,
  sanitizeUiControlSettings,
  sanitizeUiPresetId,
  uiControlToDisplayPrefs,
  withUiControlPresetApplied,
} from '@matricarmz/shared';

import { Page } from './layout/Page.js';
import { Tabs, type MenuGroupId, type MenuTabId, type TabId, type TabsLayoutPrefs, GROUP_LABELS, deriveMenuState } from './layout/Tabs.js';
import { EnginesPage } from './pages/EnginesPage.js';
import { EngineDetailsPage } from './pages/EngineDetailsPage.js';
import { EngineBrandsPage } from './pages/EngineBrandsPage.js';
import { EngineBrandDetailsPage } from './pages/EngineBrandDetailsPage.js';
import { ChangesPage } from './pages/ChangesPage.js';
import { ReportsPage } from './pages/ReportsPage.js';
import { MasterdataPage } from './pages/AdminPage.js';
import { CounterpartiesPage } from './pages/CounterpartiesPage.js';
import { CounterpartyDetailsPage } from './pages/CounterpartyDetailsPage.js';
import { ContractsPage } from './pages/ContractsPage.js';
import { ContractDetailsPage } from './pages/ContractDetailsPage.js';
import { AuthPage } from './pages/AuthPage.js';
import { SupplyRequestsPage } from './pages/SupplyRequestsPage.js';
import { SupplyRequestDetailsPage } from './pages/SupplyRequestDetailsPage.js';
import { WorkOrdersPage } from './pages/WorkOrdersPage.js';
import { WorkOrderDetailsPage } from './pages/WorkOrderDetailsPage.js';
import { PartsPage } from './pages/PartsPage.js';
import { PartDetailsPage } from './pages/PartDetailsPage.js';
import { ToolsPage } from './pages/ToolsPage.js';
import { ToolDetailsPage } from './pages/ToolDetailsPage.js';
import { ToolPropertiesPage } from './pages/ToolPropertiesPage.js';
import { ToolPropertyDetailsPage } from './pages/ToolPropertyDetailsPage.js';
import { EmployeesPage } from './pages/EmployeesPage.js';
import { EmployeeDetailsPage } from './pages/EmployeeDetailsPage.js';
import { ProductsPage } from './pages/ProductsPage.js';
import { ServicesPage } from './pages/ServicesPage.js';
import { SimpleMasterdataDetailsPage } from './pages/SimpleMasterdataDetailsPage.js';
import { SettingsPage } from './pages/SettingsPage.js';
import { NotesPage } from './pages/NotesPage.js';
import { HistoryPage } from './pages/HistoryPage.js';
import { SuperadminAuditPage } from './pages/SuperadminAuditPage.js';
import { deriveUiCaps } from './auth/permissions.js';
import { Button } from './components/Button.js';
import { ChatPanel } from './components/ChatPanel.js';
import { ErrorBoundary } from './components/ErrorBoundary.js';
import { AiAgentChat, type AiAgentChatHandle } from './components/AiAgentChat.js';
import { useAiAgentTracker } from './ai/useAiAgentTracker.js';
import { useTabFocusSelectAll } from './hooks/useTabFocusSelectAll.js';
import { useAutoGrowInputs } from './hooks/useAutoGrowInputs.js';
import { useAdaptiveListTables } from './hooks/useAdaptiveListTables.js';
import { useLiveDataRefresh } from './hooks/useLiveDataRefresh.js';
import type { CardCloseActions } from './cardCloseTypes.js';

type RecentVisitEntry = {
  id: string;
  at: number;
  title: string;
  link: ChatDeepLinkPayload;
};

const RECENT_VISITS_LIMIT = 10;
const NAVIGATION_HISTORY_LIMIT = 10;

type AppNavigationStep = {
  id: string;
  at: number;
  link: ChatDeepLinkPayload;
};

function recentVisitsStorageKey(userId: string) {
  return `matrica:recent-visits:${userId}`;
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
  });
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
    engine: 'Карточка двигателя',
    engine_brands: 'Марки двигателей',
    engine_brand: 'Карточка марки двигателя',
    contracts: 'Контракты',
    contract: 'Карточка контракта',
    counterparties: 'Контрагенты',
    counterparty: 'Карточка контрагента',
    requests: 'Заявки',
    request: 'Карточка заявки',
    work_orders: 'Наряды',
    work_order: 'Карточка наряда',
    parts: 'Детали',
    part: 'Карточка детали',
    tools: 'Инструменты',
    tool: 'Карточка инструмента',
    tool_properties: 'Свойства инструмента',
    tool_property: 'Карточка свойства инструмента',
    employees: 'Сотрудники',
    employee: 'Карточка сотрудника',
    products: 'Товары',
    product: 'Карточка товара',
    services: 'Услуги',
    service: 'Карточка услуги',
    reports: 'Отчёты',
    changes: 'Изменения',
    notes: 'Заметки',
    settings: 'Настройки',
    masterdata: 'Справочники',
  };
  return labels[tab] ?? tab;
}

const CARD_PARENT_TAB: Partial<Record<TabId, TabId>> = {
  engine: 'engines',
  engine_brand: 'engine_brands',
  request: 'requests',
  work_order: 'work_orders',
  part: 'parts',
  tool: 'tools',
  tool_property: 'tool_properties',
  employee: 'employees',
  contract: 'contracts',
  counterparty: 'counterparties',
  product: 'products',
  service: 'services',
};

const CARD_DETAIL_TABS: ReadonlyArray<TabId> = [
  'engine',
  'engine_brand',
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
  const [authStatus, setAuthStatus] = useState<AuthStatus>({ loggedIn: false, user: null, permissions: null });
  const [tab, setTabState] = useState<TabId>('history');
  const [postLoginSyncMsg, setPostLoginSyncMsg] = useState<string>('');
  const [historyInitialNoteId, setHistoryInitialNoteId] = useState<string | null>(null);
  const [recentVisits, setRecentVisits] = useState<RecentVisitEntry[]>([]);
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

  const [engines, setEngines] = useState<EngineListItem[]>([]);
  const [selectedEngineId, setSelectedEngineId] = useState<string | null>(null);
  const [engineDetails, setEngineDetails] = useState<EngineDetails | null>(null);
  const [engineLoading, setEngineLoading] = useState<boolean>(false);
  const [engineOpenError, setEngineOpenError] = useState<string>('');
  const [selectedEngineBrandId, setSelectedEngineBrandId] = useState<string | null>(null);

  const [selectedRequestId, setSelectedRequestId] = useState<string | null>(null);
  const [selectedWorkOrderId, setSelectedWorkOrderId] = useState<string | null>(null);
  const [selectedPartId, setSelectedPartId] = useState<string | null>(null);
  const [selectedToolId, setSelectedToolId] = useState<string | null>(null);
  const [selectedToolPropertyId, setSelectedToolPropertyId] = useState<string | null>(null);
  const [selectedEmployeeId, setSelectedEmployeeId] = useState<string | null>(null);
  const [selectedProductId, setSelectedProductId] = useState<string | null>(null);
  const [selectedServiceId, setSelectedServiceId] = useState<string | null>(null);
  const [selectedContractId, setSelectedContractId] = useState<string | null>(null);
  const [selectedCounterpartyId, setSelectedCounterpartyId] = useState<string | null>(null);
  const [chatOpen, setChatOpen] = useState<boolean>(true);
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
    theme: 'auto' | 'light' | 'dark';
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
  const [tabsLayout, setTabsLayout] = useState<TabsLayoutPrefs | null>(null);
  const [trashOpen, setTrashOpen] = useState(false);
  const trashButtonRef = useRef<HTMLDivElement | null>(null);
  const trashPopupRef = useRef<HTMLDivElement | null>(null);
  const [resolvedTheme, setResolvedTheme] = useState<'light' | 'dark'>('dark');
  const [cardCloseModalOpen, setCardCloseModalOpen] = useState(false);
  const [cardCloseCountdown, setCardCloseCountdown] = useState(10);
  const [cardCloseStatus, setCardCloseStatus] = useState('');
  const cardCloseActionsRef = useRef<CardCloseActions | null>(null);
  const cardCloseTargetTabRef = useRef<TabId | null>(null);
  const cardCloseFromAppRef = useRef(false);
  const cardCloseInProgressRef = useRef(false);
  const cardCloseTimerRef = useRef<number | null>(null);
  const navigateDeepLinkRef = useRef<(link: any) => Promise<void>>(async () => {});

  const isCardTab = useCallback((nextTab: TabId) => CARD_DETAIL_TABS.includes(nextTab), []);

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

  const closeCardSession = useCallback(
    async (opts: { targetTab: TabId | null; appClose: boolean }) => {
      if (cardCloseInProgressRef.current && opts.appClose) {
        return;
      }

      const targetTab = opts.targetTab;
      const fromApp = opts.appClose;
      const actions = cardCloseActionsRef.current;
      if (!actions) {
        if (fromApp) {
          window.matrica.app.respondToCloseRequest?.({ allowClose: true });
        } else {
          if (targetTab) setTabState(targetTab);
        }
        return;
      }

      let dirty = false;
      try {
        dirty = Boolean(actions.isDirty());
      } catch {
        dirty = true;
      }

      if (!dirty) {
        actions.closeWithoutSave();
        if (fromApp) {
          window.matrica.app.respondToCloseRequest?.({ allowClose: true });
        } else if (targetTab) {
          setTabState(targetTab);
        }
        return;
      }

      cardCloseInProgressRef.current = true;
      cardCloseTargetTabRef.current = targetTab;
      cardCloseFromAppRef.current = fromApp;
      clearCardCloseTimer();
      setCardCloseCountdown(10);
      setCardCloseStatus('');
      setCardCloseModalOpen(true);
      cardCloseTimerRef.current = window.setInterval(() => {
        setCardCloseCountdown((seconds) => {
          if (seconds <= 1) {
            clearCardCloseTimer();
            void finalizeCardClose('save');
            return 0;
          }
          return seconds - 1;
        });
      }, 1000);
    },
    [setTabState],
  );

  const finalizeCardClose = useCallback(
    async (decision: 'save' | 'discard') => {
      clearCardCloseTimer();
      setCardCloseModalOpen(false);
      cardCloseInProgressRef.current = false;

      const actions = cardCloseActionsRef.current;
      const targetTab = cardCloseTargetTabRef.current;
      const fromApp = cardCloseFromAppRef.current;
      cardCloseTargetTabRef.current = null;
      cardCloseFromAppRef.current = false;

      if (!actions) {
        if (fromApp) window.matrica.app.respondToCloseRequest?.({ allowClose: true });
        return;
      }

      try {
        if (decision === 'save') {
          await actions.saveAndClose();
        } else {
          actions.closeWithoutSave();
        }
      } catch (e) {
        setCardCloseStatus(`Ошибка сохранения: ${String(e)}`);
        cardCloseInProgressRef.current = false;
        clearQueuedHistoryReplay(true);
        return;
      }

      if (replayQueuedHistoryStep()) {
        if (fromApp) {
          window.matrica.app.respondToCloseRequest?.({ allowClose: true });
        }
        return;
      }

      if (targetTab) {
        setTabState(targetTab);
      }

      if (fromApp) {
        window.matrica.app.respondToCloseRequest?.({ allowClose: true });
      }
    },
    [setTabState],
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
    requestTabSwitch(nextTab);
  }, [requestTabSwitch]);

  const requestCardClose = useCallback(() => {
    const parentTab = CARD_PARENT_TAB[tab];
    if (parentTab) {
      void closeCardSession({ targetTab: parentTab, appClose: false });
    }
  }, [tab, closeCardSession]);

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

  function sameEngineList(a: EngineListItem[], b: EngineListItem[]) {
    if (a === b) return true;
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      const left = a[i];
      const right = b[i];
      if (!left || !right) return false;
      if (left.id !== right.id) return false;
      if (Number(left.updatedAt ?? 0) !== Number(right.updatedAt ?? 0)) return false;
      if (String(left.syncStatus ?? '') !== String(right.syncStatus ?? '')) return false;
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
      if (!isCardTab(tab)) return;
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
        window.matrica.app?.respondToCloseRequest?.({ allowClose: true });
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
  }, [closeCardSession, isCardTab, tab]);

  useEffect(() => {
    const userId = authStatus.loggedIn ? authStatus.user?.id ?? '' : '';
    if (!userId) {
      setTabsLayout(null);
      return;
    }
    let alive = true;
    void window.matrica.settings
      .uiGet({ userId })
      .then((r: any) => {
        if (!alive) return;
        if (r?.ok) setTabsLayout((r.tabsLayout as TabsLayoutPrefs | null) ?? null);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [authStatus.loggedIn, authStatus.user?.id]);

  useEffect(() => {
    const userId = authStatus.loggedIn ? String(authStatus.user?.id ?? '').trim() : '';
    if (!userId) {
      setRecentVisits([]);
      lastRecordedVisitSigRef.current = '';
      return;
    }
    try {
      const key = recentVisitsStorageKey(userId);
      setRecentVisits(parseRecentVisits(window.localStorage.getItem(key)));
    } catch {
      setRecentVisits([]);
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
    const id = setInterval(() => void poll(), 15_000);
    return () => {
      alive = false;
      clearInterval(id);
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
    setSelectedPartId(null);
    setSelectedEmployeeId(null);
    setSelectedProductId(null);
    setSelectedServiceId(null);
    setSelectedCounterpartyId(null);
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
    const id = setInterval(() => void tick(), 30_000);
    return () => {
      alive = false;
      clearInterval(id);
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
    setSelectedContractId(null);
    setSelectedRequestId(null);
    setSelectedWorkOrderId(null);
    setSelectedPartId(null);
    setSelectedEmployeeId(null);
    setSelectedProductId(null);
    setSelectedServiceId(null);
    setSelectedCounterpartyId(null);
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
    const id = setInterval(() => void poll(), 30_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [authStatus.loggedIn]);

  useEffect(() => {
    const mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
    const pick = () => {
      if (uiPrefs.theme === 'light') return 'light';
      if (uiPrefs.theme === 'dark') return 'dark';
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

  useEffect(() => {
    const root = document.documentElement;
    const listSize = Math.max(10, Math.min(48, Number(uiPrefs.displayPrefs?.listFontSize ?? DEFAULT_UI_DISPLAY_PREFS.listFontSize)));
    const cardSize = Math.max(10, Math.min(48, Number(uiPrefs.displayPrefs?.cardFontSize ?? DEFAULT_UI_DISPLAY_PREFS.cardFontSize)));
    root.style.setProperty('--ui-list-font-size', `${listSize}px`);
    root.style.setProperty('--ui-card-font-size', `${cardSize}px`);
  }, [uiPrefs.displayPrefs]);

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
    const id = setInterval(() => void poll(), 20_000);
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
  const canAiAgent = authStatus.loggedIn && canChat;
  const caps = viewMode
    ? {
        ...capsBase,
        canUseSync: false,
        canUseUpdates: false,
        canEditEngines: false,
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
        canViewParts: false,
        canManageEmployees: false,
        canViewEmployees: false,
      }
    : capsBase;
  const availableTabs: MenuTabId[] = [
    ...(authStatus.loggedIn ? (['history'] as const) : []),
    ...(caps.canViewMasterData ? (['contracts'] as const) : []),
    ...(caps.canViewEngines ? (['engines'] as const) : []),
    ...(caps.canViewMasterData ? (['engine_brands'] as const) : []),
    ...(caps.canViewMasterData ? (['counterparties'] as const) : []),
    ...(caps.canViewSupplyRequests ? (['requests'] as const) : []),
    ...(caps.canViewWorkOrders ? (['work_orders'] as const) : []),
    ...(caps.canViewParts ? (['parts'] as const) : []),
    ...(caps.canViewMasterData ? (['tools'] as const) : []),
    ...(caps.canViewEmployees ? (['employees'] as const) : []),
    ...(caps.canViewMasterData ? (['products', 'services'] as const) : []),
    ...(caps.canUseUpdates ? (['changes'] as const) : []),
    ...(authStatus.loggedIn ? (['notes'] as const) : []),
    ...(caps.canViewReports ? (['reports'] as const) : []),
    ...(caps.canViewMasterData ? (['masterdata'] as const) : []),
    ...(String(authStatus.user?.role ?? '').toLowerCase() === 'superadmin' ? (['audit'] as const) : []),
  ];
  const menuState = deriveMenuState(availableTabs, tabsLayout);
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
    | 'counterparty'
  > = authStatus.loggedIn ? 'settings' : 'auth';
  const userLabel = authStatus.loggedIn ? authStatus.user?.username ?? 'Пользователь' : 'Вход';
  const menuLabels: Record<MenuTabId, string> = {
    history: 'История',
    masterdata: 'Справочники',
    contracts: 'Контракты',
    changes: 'Изменения',
    engines: 'Двигатели',
    engine_brands: 'Марки двигателей',
    counterparties: 'Контрагенты',
    requests: 'Заявки',
    work_orders: 'Наряды',
    parts: 'Детали',
    tools: 'Инструменты',
    products: 'Товары',
    services: 'Услуги',
    employees: 'Сотрудники',
    reports: 'Отчёты',
    audit: 'Журнал',
    admin: 'Админ',
    auth: 'Вход',
    notes: 'Заметки',
    settings: 'Настройки',
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
    const id = setInterval(() => void tick(), 15_000);
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
    const id = setInterval(() => void tick(), 60_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [authStatus.loggedIn, viewMode]);

  // Gate: если вкладка скрылась по permissions/настройкам — переключаем на первую доступную.
  useEffect(() => {
    if (
      tab === 'engine' ||
      tab === 'engine_brand' ||
      tab === 'request' ||
      tab === 'work_order' ||
      tab === 'part' ||
      tab === 'tool' ||
      tab === 'tool_properties' ||
      tab === 'tool_property' ||
      tab === 'employee' ||
      tab === 'contract' ||
      tab === 'counterparty' ||
      tab === 'product' ||
      tab === 'service'
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
    const id = setInterval(() => void poll(), 10_000);
    return () => {
      alive = false;
      clearInterval(id);
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

  async function openEngine(id: string) {
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

  async function openRequest(id: string) {
    setSelectedRequestId(id);
    setTab('request');
  }

  async function openWorkOrder(id: string) {
    setSelectedWorkOrderId(id);
    setTab('work_order');
  }

  async function openEngineBrand(id: string) {
    setSelectedEngineBrandId(id);
    setTab('engine_brand');
  }

  async function openContract(id: string) {
    setSelectedContractId(id);
    setTab('contract');
  }

  async function openPart(id: string) {
    setSelectedPartId(id);
    setTab('part');
  }

  async function openTool(id: string) {
    setSelectedToolId(id);
    setTab('tool');
  }

  async function openToolProperty(id: string) {
    setSelectedToolPropertyId(id);
    setTab('tool_property');
  }

  async function openEmployee(id: string) {
    setSelectedEmployeeId(id);
    setTab('employee');
  }

  async function openProduct(id: string) {
    setSelectedProductId(id);
    setTab('product');
  }

  async function openService(id: string) {
    setSelectedServiceId(id);
    setTab('service');
  }

  async function openCounterparty(id: string) {
    setSelectedCounterpartyId(id);
    setTab('counterparty');
  }

  const openByCode = {
    customer: openCounterparty,
    counterparty: openCounterparty,
    contract: openContract,
    part: openPart,
    engine_brand: openEngineBrand,
    engineBrand: openEngineBrand,
    service: openService,
    product: openProduct,
    employee: openEmployee,
    tool_property: openToolProperty,
  };

  function openNoteFromHistory(noteId?: string | null) {
    setHistoryInitialNoteId(noteId ? String(noteId) : null);
    setTab('notes');
  }

  function openChatFromHistory() {
    setChatOpen(true);
  }

  async function navigateDeepLink(link: any) {
    const tabId = String(link?.tab ?? '') as any;
    const engineId = link?.engineId ? String(link.engineId) : null;
    const requestId = link?.requestId ? String(link.requestId) : null;
    const partId = link?.partId ? String(link.partId) : null;
    const toolId = link?.toolId ? String(link.toolId) : null;
    const contractId = link?.contractId ? String(link.contractId) : null;
    const employeeId = link?.employeeId ? String(link.employeeId) : null;
    const engineBrandId = link?.engineBrandId ? String(link.engineBrandId) : null;
    const productId = link?.productId ? String(link.productId) : null;
    const serviceId = link?.serviceId ? String(link.serviceId) : null;
    const counterpartyId = link?.counterpartyId ? String(link.counterpartyId) : null;

    // Prefer opening specific entities if IDs are present.
    if (engineId) {
      await openEngine(engineId);
      return;
    }
    if (requestId) {
      await openRequest(requestId);
      return;
    }
    if (partId) {
      await openPart(partId);
      return;
    }
    if (toolId) {
      await openTool(toolId);
      return;
    }
    if (contractId) {
      await openContract(contractId);
      return;
    }
    if (employeeId) {
      await openEmployee(employeeId);
      return;
    }
    if (productId) {
      await openProduct(productId);
      return;
    }
    if (serviceId) {
      await openService(serviceId);
      return;
    }
    if (counterpartyId) {
      await openCounterparty(counterpartyId);
      return;
    }
    if (engineBrandId) {
      await openEngineBrand(engineBrandId);
      return;
    }
    setTab(tabId);
  }
  navigateDeepLinkRef.current = navigateDeepLink;

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
      parts: 'Детали',
      part: 'Карточка детали',
      tools: 'Инструменты',
      tool: 'Карточка инструмента',
      tool_properties: 'Свойства инструментов',
      tool_property: 'Карточка свойства инструмента',
      products: 'Товары',
      product: 'Карточка товара',
      services: 'Услуги',
      service: 'Карточка услуги',
      employees: 'Сотрудники',
      employee: 'Карточка сотрудника',
      reports: 'Отчёты',
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
      product: 'Товары',
      service: 'Услуги',
    };

    const crumbs: string[] = [];
    const parentLabel = parent[tab];
    if (parentLabel) crumbs.push(parentLabel);
    const label = labels[tab] ?? String(tab);
    if (label) crumbs.push(label);

    if (tab === 'engine') {
      const number = String((engineDetails?.attributes as any)?.engine_number ?? '').trim();
      if (number) crumbs.push(`№ ${number}`);
      else if (selectedEngineId) crumbs.push(`ID ${shortId(selectedEngineId)}`);
    }
    if (tab === 'engine_brand' && selectedEngineBrandId) crumbs.push(`ID ${shortId(selectedEngineBrandId)}`);
    if (tab === 'request' && selectedRequestId) crumbs.push(`ID ${shortId(selectedRequestId)}`);
    if (tab === 'work_order' && selectedWorkOrderId) crumbs.push(`ID ${shortId(selectedWorkOrderId)}`);
    if (tab === 'part' && selectedPartId) crumbs.push(`ID ${shortId(selectedPartId)}`);
    if (tab === 'tool' && selectedToolId) crumbs.push(`ID ${shortId(selectedToolId)}`);
    if (tab === 'tool_property' && selectedToolPropertyId) crumbs.push(`ID ${shortId(selectedToolPropertyId)}`);
    if (tab === 'contract' && selectedContractId) crumbs.push(`ID ${shortId(selectedContractId)}`);
    if (tab === 'counterparty' && selectedCounterpartyId) crumbs.push(`ID ${shortId(selectedCounterpartyId)}`);
    if (tab === 'employee' && selectedEmployeeId) crumbs.push(`ID ${shortId(selectedEmployeeId)}`);
    if (tab === 'product' && selectedProductId) crumbs.push(`ID ${shortId(selectedProductId)}`);
    if (tab === 'service' && selectedServiceId) crumbs.push(`ID ${shortId(selectedServiceId)}`);

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
              : tab === 'part'
                ? selectedPartId ?? null
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
                      : null,
      entityType:
        tab === 'engine'
          ? 'engine'
          : tab === 'engine_brand'
            ? 'engine_brand'
            : tab === 'request'
              ? 'supply_request'
              : tab === 'part'
                ? 'part'
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
                      : null,
      breadcrumbs: buildChatBreadcrumbs(),
    }),
    [
      tab,
      selectedEngineId,
      selectedEngineBrandId,
      selectedRequestId,
      selectedPartId,
      selectedToolId,
      selectedToolPropertyId,
      selectedContractId,
      selectedEmployeeId,
      selectedProductId,
      selectedServiceId,
      selectedCounterpartyId,
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
      partId: tab === 'part' ? selectedPartId ?? null : null,
      toolId: tab === 'tool' ? selectedToolId ?? null : null,
      toolPropertyId: tab === 'tool_property' ? selectedToolPropertyId ?? null : null,
      contractId: tab === 'contract' ? selectedContractId ?? null : null,
      employeeId: tab === 'employee' ? selectedEmployeeId ?? null : null,
      productId: tab === 'product' ? selectedProductId ?? null : null,
      serviceId: tab === 'service' ? selectedServiceId ?? null : null,
      counterpartyId: tab === 'counterparty' ? selectedCounterpartyId ?? null : null,
      breadcrumbs: buildChatBreadcrumbs(),
    }),
    [
      tab,
      selectedEngineId,
      selectedEngineBrandId,
      selectedRequestId,
      selectedPartId,
      selectedToolId,
      selectedToolPropertyId,
      selectedContractId,
      selectedEmployeeId,
      selectedProductId,
      selectedServiceId,
      selectedCounterpartyId,
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
          .sendFile({ recipientUserId, path: String((downloaded as any).localPath) })
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
      ? 'Матрица РМЗ — История'
    : tab === 'engines'
      ? 'Матрица РМЗ — Двигатели'
      : tab === 'engine_brands'
        ? 'Матрица РМЗ — Марки двигателей'
      : tab === 'engine'
        ? 'Матрица РМЗ — Карточка двигателя'
        : tab === 'engine_brand'
          ? 'Матрица РМЗ — Карточка марки двигателя'
        : tab === 'products'
          ? 'Матрица РМЗ — Товары'
          : tab === 'product'
            ? 'Матрица РМЗ — Карточка товара'
            : tab === 'services'
              ? 'Матрица РМЗ — Услуги'
              : tab === 'service'
                ? 'Матрица РМЗ — Карточка услуги'
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
            : tab === 'part'
              ? 'Матрица РМЗ — Карточка детали'
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
          <div style={{ fontWeight: 800, fontSize: 16 }}>Карточка закрывается</div>
          <div style={{ marginTop: 8, color: 'var(--muted)' }}>Сохранить изменения в карточке?</div>
          <div style={{ marginTop: 10, color: 'var(--muted)' }}>Если не выбрать действие, изменения будут сохранены через {cardCloseCountdown} сек.</div>
          {cardCloseStatus ? <div style={{ marginTop: 8, color: 'var(--danger)' }}>{cardCloseStatus}</div> : null}
          <div style={{ marginTop: 14, display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
            <Button tone="danger" variant="ghost" onClick={() => void finalizeCardClose('discard')}>
              Не сохранять
            </Button>
            <Button variant="ghost" tone="success" onClick={() => void finalizeCardClose('save')}>
              Сохранить
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

  return (
    <ErrorBoundary onError={(error, info) => recordFatalError(error, info)}>
      <Page
        title={pageTitle}
        uiTheme={resolvedTheme}
        center={headerStatus}
        right={
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', justifyContent: 'flex-end' }}>
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
              <Button
                variant="ghost"
                onClick={() => void sendCurrentPositionToChat()}
                title="Отправить ссылку на текущий раздел в чат"
              >
                Отправить в чат
              </Button>
              <Button
                variant="ghost"
                onClick={() => void saveCurrentPositionToNotes()}
                title="Сохранить ссылку на текущий раздел в заметки"
              >
                Сохранить в заметки
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
            onClick={() => setTab(userTab)}
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
        {renderFullSyncModal()}
        {renderFatalModal()}
        {renderCardCloseModal()}
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
          <div style={{ flex: '0 0 auto' }}>
            <Tabs
              tab={tab}
              onTab={(t) => {
                const isUserTab = t === userTab;
                if (!authStatus.loggedIn && t !== 'auth') {
                  setTab('auth');
                  return;
                }
                if (!visibleTabs.includes(t) && !isUserTab) return;
                setTab(t);
              }}
              availableTabs={availableTabs}
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
            />
          </div>

          <div className="ui-content-viewport" style={{ marginTop: 6, flex: '1 1 auto', minHeight: 0, overflow: 'auto' }}>
            {!authStatus.loggedIn && tab !== 'auth' && (
              <div style={{ color: 'var(--muted)' }}>Требуется вход.</div>
            )}

        {tab === 'history' && authStatus.loggedIn && (
          <HistoryPage
            meUserId={authStatus.user?.id ?? ''}
            recentVisits={recentVisits}
            onNavigate={(link) => {
              void navigateDeepLink(link);
            }}
            onOpenNotes={(noteId) => openNoteFromHistory(noteId)}
            onOpenChat={() => openChatFromHistory()}
          />
        )}

        {tab === 'engines' && (
          <EnginesPage
            engines={engines}
            onRefresh={refreshEngines}
            onOpen={openEngine}
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
          />
        )}

        {tab === 'engine_brands' && (
          <EngineBrandsPage
            onOpen={openEngineBrand}
            canCreate={caps.canEditMasterData}
            canViewMasterData={caps.canViewMasterData}
          />
        )}

        {tab === 'contracts' && (
          <ContractsPage
            onOpen={openContract}
            canCreate={caps.canEditMasterData}
            canDelete={caps.canEditMasterData}
          />
        )}

        {tab === 'counterparties' && (
          <CounterpartiesPage
            onOpen={openCounterparty}
            canCreate={caps.canEditMasterData}
            canDelete={caps.canEditMasterData}
            canViewMasterData={caps.canViewMasterData}
          />
        )}

        {tab === 'requests' && (
          <SupplyRequestsPage
            onOpen={openRequest}
            canCreate={caps.canCreateSupplyRequests}
          />
        )}

        {tab === 'work_orders' && (
          <WorkOrdersPage
            onOpen={openWorkOrder}
            canCreate={caps.canCreateWorkOrders}
            canDelete={caps.canEditWorkOrders}
          />
        )}

        {tab === 'engine' && selectedEngineId && engineDetails && (
          <EngineDetailsPage
            key={selectedEngineId}
            engineId={selectedEngineId}
            engine={engineDetails}
            onReload={reloadEngine}
            onEngineUpdated={async () => {
              await refreshEngines();
              await reloadEngine();
            }}
            canEditEngines={caps.canEditEngines}
            canViewOperations={caps.canViewOperations}
            canEditOperations={caps.canEditOperations}
            canPrintEngineCard={caps.canPrintReports}
            canViewMasterData={caps.canViewMasterData}
            canEditMasterData={caps.canEditMasterData}
            canExportReports={caps.canExportReports}
            canViewFiles={caps.canViewFiles}
            canUploadFiles={caps.canUploadFiles}
            registerCardCloseActions={registerCardCloseActions}
            requestClose={requestCardClose}
            onOpenEngineBrand={openEngineBrand}
            onOpenCounterparty={openCounterparty}
            onOpenContract={openContract}
            onClose={() => {
              setSelectedEngineId(null);
              setEngineDetails(null);
              setTabState('engines');
              void refreshEngines();
            }}
          />
      )}

        {tab === 'engine_brand' && selectedEngineBrandId && (
          <EngineBrandDetailsPage
            key={selectedEngineBrandId}
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
        {tab === 'engine' && selectedEngineId && !engineDetails && (
          <div style={{ padding: 16, border: '1px solid #e5e7eb', borderRadius: 12 }}>
            <div style={{ fontWeight: 600, marginBottom: 6 }}>Карточка двигателя</div>
            <div style={{ color: '#6b7280', marginBottom: 12 }}>
              {engineLoading ? 'Загрузка...' : engineOpenError || 'Нет данных для отображения.'}
            </div>
            <Button onClick={() => setTab('engines')}>Вернуться к списку</Button>
          </div>
        )}

        {tab === 'request' && selectedRequestId && (
          <SupplyRequestDetailsPage
            key={selectedRequestId}
            id={selectedRequestId}
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
            registerCardCloseActions={registerCardCloseActions}
            requestClose={requestCardClose}
            onOpenProduct={openProduct}
            onOpenService={openService}
            onClose={() => {
              setSelectedRequestId(null);
              setTabState('requests');
            }}
          />
        )}

        {tab === 'work_order' && selectedWorkOrderId && (
          <WorkOrderDetailsPage
            key={selectedWorkOrderId}
            id={selectedWorkOrderId}
            canEdit={caps.canEditWorkOrders}
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

        {tab === 'parts' && (
          <PartsPage
            onOpen={async (id) => {
              setSelectedPartId(id);
              setTab('part');
            }}
            canCreate={caps.canCreateParts}
            canDelete={caps.canDeleteParts}
          />
        )}

        {tab === 'tools' && (
          <ToolsPage
            onOpen={openTool}
            onOpenProperties={() => setTab('tool_properties')}
            canCreate={caps.canEditMasterData}
            canDelete={caps.canEditMasterData}
          />
        )}

        {tab === 'tool_properties' && (
          <ToolPropertiesPage
            onOpen={openToolProperty}
            canCreate={caps.canEditMasterData}
            canDelete={caps.canEditMasterData}
          />
        )}

        {tab === 'employees' && (
          <EmployeesPage
            onOpen={async (id) => {
              setSelectedEmployeeId(id);
              setTab('employee');
            }}
            canCreate={caps.canManageEmployees}
            canDelete={caps.canManageEmployees}
            refreshKey={employeesRefreshKey}
          />
        )}

        {tab === 'products' && (
          <ProductsPage
            onOpen={openProduct}
            canCreate={caps.canEditMasterData}
            canDelete={caps.canEditMasterData}
            canViewMasterData={caps.canViewMasterData}
          />
        )}

        {tab === 'services' && (
          <ServicesPage
            onOpen={openService}
            canCreate={caps.canEditMasterData}
            canDelete={caps.canEditMasterData}
            canViewMasterData={caps.canViewMasterData}
          />
        )}

        {tab === 'part' && selectedPartId && (
          <PartDetailsPage
            key={selectedPartId}
            partId={selectedPartId}
            canEdit={caps.canEditParts}
            canDelete={caps.canDeleteParts}
            canViewFiles={caps.canViewFiles}
            canUploadFiles={caps.canUploadFiles}
            registerCardCloseActions={registerCardCloseActions}
            requestClose={requestCardClose}
            onOpenCustomer={openCounterparty}
            onOpenContract={openContract}
            onOpenEngineBrand={openEngineBrand}
            onOpenByCode={openByCode}
            onClose={() => {
              setSelectedPartId(null);
              setTabState('parts');
            }}
          />
        )}

        {tab === 'tool' && selectedToolId && (
          <ToolDetailsPage
            key={selectedToolId}
            toolId={selectedToolId}
            canEdit={caps.canEditMasterData}
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

        {tab === 'tool_property' && selectedToolPropertyId && (
          <ToolPropertyDetailsPage
            key={selectedToolPropertyId}
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

        {tab === 'contract' && selectedContractId && (
          <ContractDetailsPage
            key={selectedContractId}
            contractId={selectedContractId}
            canEdit={caps.canEditMasterData}
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
            onOpenPart={openPart}
            onOpenEngineBrand={openEngineBrand}
          />
        )}

        {tab === 'counterparty' && selectedCounterpartyId && (
          <CounterpartyDetailsPage
            key={selectedCounterpartyId}
            counterpartyId={selectedCounterpartyId}
            canEdit={caps.canEditMasterData}
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

        {tab === 'employee' && selectedEmployeeId && (
          <EmployeeDetailsPage
            key={selectedEmployeeId}
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

        {tab === 'product' && selectedProductId && (
          <SimpleMasterdataDetailsPage
            key={selectedProductId}
            title="Карточка товара"
            entityId={selectedProductId}
            ownerType="product"
            typeCode="product"
            canEdit={caps.canEditMasterData}
            canViewFiles={caps.canViewFiles}
            canUploadFiles={caps.canUploadFiles}
            registerCardCloseActions={registerCardCloseActions}
            requestClose={requestCardClose}
            onOpenCustomer={openCounterparty}
            onClose={() => {
              setSelectedProductId(null);
              setTabState('products');
            }}
          />
        )}

        {tab === 'service' && selectedServiceId && (
          <SimpleMasterdataDetailsPage
            key={selectedServiceId}
            title="Карточка услуги"
            entityId={selectedServiceId}
            ownerType="service"
            typeCode="service"
            canEdit={caps.canEditMasterData}
            canViewFiles={caps.canViewFiles}
            canUploadFiles={caps.canUploadFiles}
            registerCardCloseActions={registerCardCloseActions}
            requestClose={requestCardClose}
            onOpenCustomer={openCounterparty}
            onClose={() => {
              setSelectedServiceId(null);
              setTabState('services');
            }}
          />
        )}

        {tab === 'changes' && authStatus.loggedIn && authStatus.user && (
          <ChangesPage
            me={authStatus.user}
            canDecideAsAdmin={['admin', 'superadmin'].includes(String(authStatus.user.role ?? '').toLowerCase())}
          />
        )}

        {tab === 'notes' && (
          <NotesPage
            meUserId={authStatus.user?.id ?? ''}
            canEdit={authStatus.loggedIn && !viewMode}
            initialNoteId={historyInitialNoteId}
            onNavigate={(link) => {
              void navigateDeepLink(link);
            }}
            onSendToChat={sendNoteToChat}
            onBurningCountChange={(count) => setNotesAlertCount(count)}
          />
        )}

        {tab === 'settings' && (
          <SettingsPage
            uiPrefs={uiPrefs}
            onUiPrefsChange={setUiPrefs}
            onLogout={() => {
              void window.matrica.auth.status().then(setAuthStatus).catch(() => {});
              setTab('auth');
            }}
          />
        )}

        {tab === 'reports' && <ReportsPage canExport={caps.canExportReports} />}

        {tab === 'masterdata' && (
          <MasterdataPage
            canViewMasterData={caps.canViewMasterData}
            canEditMasterData={caps.canEditMasterData}
          />
        )}

        {tab === 'audit' && String(authStatus.user?.role ?? '').toLowerCase() === 'superadmin' && <SuperadminAuditPage />}

        {tab === 'admin' && <div style={{ color: 'var(--muted)' }}>Раздел перемещён в карточку сотрудника.</div>}

        {tab === 'auth' && (
          <AuthPage
            onChanged={(s) => {
              setAuthStatus(s);
              if (s.loggedIn) setTab('history');
            }}
          />
        )}


        {tab === 'engine' && (!selectedEngineId || !engineDetails) && (
          <div style={{ color: 'var(--muted)' }}>Выберите двигатель из списка.</div>
      )}

        {tab === 'contract' && !selectedContractId && (
          <div style={{ color: 'var(--muted)' }}>Выберите контракт из списка.</div>
        )}

        {tab === 'counterparty' && !selectedCounterpartyId && (
          <div style={{ color: 'var(--muted)' }}>Выберите контрагента из списка.</div>
        )}

        {tab === 'request' && !selectedRequestId && (
          <div style={{ color: 'var(--muted)' }}>Выберите заявку из списка.</div>
        )}

        {tab === 'work_order' && !selectedWorkOrderId && (
          <div style={{ color: 'var(--muted)' }}>Выберите наряд из списка.</div>
        )}

        {tab === 'part' && !selectedPartId && (
          <div style={{ color: 'var(--muted)' }}>Выберите деталь из списка.</div>
        )}

        {tab === 'employee' && !selectedEmployeeId && (
          <div style={{ color: 'var(--muted)' }}>Выберите сотрудника из списка.</div>
        )}

        {tab === 'product' && !selectedProductId && (
          <div style={{ color: 'var(--muted)' }}>Выберите товар из списка.</div>
        )}

        {tab === 'service' && !selectedServiceId && (
          <div style={{ color: 'var(--muted)' }}>Выберите услугу из списка.</div>
        )}
          </div>
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
    </Page>
    </ErrorBoundary>
  );
}


