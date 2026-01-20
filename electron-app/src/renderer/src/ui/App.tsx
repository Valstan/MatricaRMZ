import React, { useEffect, useRef, useState } from 'react';

import type { AuditItem, AuthStatus, EngineDetails, EngineListItem, OperationItem, ServerHealthResult, SyncStatus } from '@matricarmz/shared';

import { Page } from './layout/Page.js';
import { Tabs, type TabId } from './layout/Tabs.js';
import { EnginesPage } from './pages/EnginesPage.js';
import { EngineDetailsPage } from './pages/EngineDetailsPage.js';
import { ChangesPage } from './pages/ChangesPage.js';
import { ReportsPage } from './pages/ReportsPage.js';
import { MasterdataPage } from './pages/AdminPage.js';
import { ContractsPage } from './pages/ContractsPage.js';
import { ContractDetailsPage } from './pages/ContractDetailsPage.js';
import { AuditPage } from './pages/AuditPage.js';
import { AuthPage } from './pages/AuthPage.js';
import { SupplyRequestsPage } from './pages/SupplyRequestsPage.js';
import { SupplyRequestDetailsPage } from './pages/SupplyRequestDetailsPage.js';
import { PartsPage } from './pages/PartsPage.js';
import { PartDetailsPage } from './pages/PartDetailsPage.js';
import { EmployeesPage } from './pages/EmployeesPage.js';
import { EmployeeDetailsPage } from './pages/EmployeeDetailsPage.js';
import { SettingsPage } from './pages/SettingsPage.js';
import { deriveUiCaps } from './auth/permissions.js';
import { Button } from './components/Button.js';
import { ChatPanel } from './components/ChatPanel.js';

export function App() {
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const [authStatus, setAuthStatus] = useState<AuthStatus>({ loggedIn: false, user: null, permissions: null });
  const [tab, setTab] = useState<TabId>('engines');
  const [postLoginSyncMsg, setPostLoginSyncMsg] = useState<string>('');
  const prevLoggedIn = useRef<boolean>(false);
  const [clientVersion, setClientVersion] = useState<string>('');
  const [serverInfo, setServerInfo] = useState<ServerHealthResult | null>(null);
  const [backupMode, setBackupMode] = useState<{ mode: 'live' | 'backup'; backupDate: string | null } | null>(null);

  const [engines, setEngines] = useState<EngineListItem[]>([]);
  const [selectedEngineId, setSelectedEngineId] = useState<string | null>(null);
  const [engineDetails, setEngineDetails] = useState<EngineDetails | null>(null);
  const [ops, setOps] = useState<OperationItem[]>([]);
  const [audit, setAudit] = useState<AuditItem[]>([]);

  const [selectedRequestId, setSelectedRequestId] = useState<string | null>(null);
  const [selectedPartId, setSelectedPartId] = useState<string | null>(null);
  const [selectedEmployeeId, setSelectedEmployeeId] = useState<string | null>(null);
  const [selectedContractId, setSelectedContractId] = useState<string | null>(null);
  const [chatOpen, setChatOpen] = useState<boolean>(true);
  const [chatContext, setChatContext] = useState<{ selectedUserId: string | null; adminMode: boolean }>({
    selectedUserId: null,
    adminMode: false,
  });
  const [chatUnreadTotal, setChatUnreadTotal] = useState<number>(0);
  const [presence, setPresence] = useState<{ online: boolean; lastActivityAt: number | null } | null>(null);
  const [uiPrefs, setUiPrefs] = useState<{ theme: 'auto' | 'light' | 'dark'; chatSide: 'left' | 'right' }>({
    theme: 'auto',
    chatSide: 'right',
  });
  const [resolvedTheme, setResolvedTheme] = useState<'light' | 'dark'>('dark');

  useEffect(() => {
    void refreshEngines();
    void window.matrica.auth.status().then(setAuthStatus).catch(() => {});
    void window.matrica.app.version().then((r) => (r.ok ? setClientVersion(r.version) : setClientVersion(''))).catch(() => {});
    void refreshServerHealth();
    void window.matrica.settings.uiGet().then((r: any) => {
      if (r?.ok) setUiPrefs({ theme: r.theme ?? 'auto', chatSide: r.chatSide ?? 'right' });
    });
  }, []);

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
    const id = setInterval(() => void poll(), 2000);
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
    setOps([]);
    setSelectedContractId(null);
    setSelectedRequestId(null);
    setSelectedPartId(null);
    setSelectedEmployeeId(null);
  }, [backupMode?.mode, backupMode?.backupDate]);

  async function refreshServerHealth() {
    const r = await window.matrica.server.health().catch(() => null);
    if (r) setServerInfo(r);
  }

  // Update backend version occasionally (it can change after deploy).
  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const r = await window.matrica.server.health();
        if (!alive) return;
        setServerInfo(r);
      } catch {
        // ignore
      }
    };
    const id = setInterval(() => void poll(), 30_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  async function runSyncNow(opts?: { showStatusMessage?: boolean }) {
    try {
      if (backupMode?.mode === 'backup') {
        if (opts?.showStatusMessage) setPostLoginSyncMsg('Режим просмотра резервной копии: синхронизация отключена.');
        return;
      }
      if (opts?.showStatusMessage) setPostLoginSyncMsg('Синхронизация…');
      const r = await window.matrica.sync.run();
      if (r.ok) {
        await refreshEngines();
        if (opts?.showStatusMessage) setPostLoginSyncMsg(`Синхронизация выполнена: push=${r.pushed}, pull=${r.pulled}.`);
      } else {
        if (opts?.showStatusMessage) setPostLoginSyncMsg(`Не удалось синхронизироваться: ${r.error ?? 'unknown'}.`);
      }
    } catch (e) {
      if (opts?.showStatusMessage) setPostLoginSyncMsg(`Не удалось синхронизироваться: ${String(e)}.`);
    } finally {
      if (opts?.showStatusMessage) setTimeout(() => setPostLoginSyncMsg(''), 12_000);
    }
  }

  // After successful login: run one sync so the user immediately sees shared data (e.g. engines created by admins).
  useEffect(() => {
    const was = prevLoggedIn.current;
    const now = authStatus.loggedIn === true;
    prevLoggedIn.current = now;
    if (now && !was && backupMode?.mode !== 'backup') {
      setPostLoginSyncMsg('После входа выполняю синхронизацию…');
      void runSyncNow({ showStatusMessage: true });
    }
  }, [authStatus.loggedIn, backupMode?.mode]);

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

  const capsBase = deriveUiCaps(authStatus.permissions ?? null);
  const viewMode = backupMode?.mode === 'backup';
  const canChat = !!authStatus.permissions?.['chat.use'];
  const canChatExport = !!authStatus.permissions?.['chat.export'];
  const canChatAdminView = !!authStatus.permissions?.['chat.admin.view'];
  const caps = viewMode
    ? {
        ...capsBase,
        canUseSync: false,
        canUseUpdates: false,
        canEditEngines: false,
        canEditOperations: false,
        canCreateSupplyRequests: false,
        canEditSupplyRequests: false,
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
      }
    : capsBase;
  const visibleTabs: Exclude<TabId, 'engine' | 'request' | 'part' | 'employee' | 'contract'>[] = [
    ...(caps.canViewMasterData ? (['contracts'] as const) : []),
    ...(caps.canViewEngines ? (['engines'] as const) : []),
    ...(caps.canViewSupplyRequests ? (['requests'] as const) : []),
    ...(caps.canViewParts ? (['parts'] as const) : []),
    ...(caps.canManageEmployees ? (['employees'] as const) : []),
    ...(caps.canUseUpdates ? (['changes'] as const) : []),
    ...(caps.canViewReports ? (['reports'] as const) : []),
    ...(caps.canViewMasterData ? (['masterdata'] as const) : []),
    ...(caps.canViewAudit ? (['audit'] as const) : []),
  ];
  const visibleTabsKey = visibleTabs.join('|');
  const userTab: Exclude<TabId, 'engine' | 'request' | 'part' | 'employee' | 'contract'> = authStatus.loggedIn ? 'settings' : 'auth';
  const userLabel = authStatus.loggedIn ? authStatus.user?.username ?? 'Пользователь' : 'Вход';

  // Gate: без входа показываем только вкладку "Вход".
  useEffect(() => {
    if (!authStatus.loggedIn && tab !== 'auth') setTab('auth');
  }, [authStatus.loggedIn, tab]);

  // Gate: chat requires auth + permission.
  useEffect(() => {
    if (!authStatus.loggedIn || !canChat) setChatOpen(false);
  }, [authStatus.loggedIn, canChat]);

  // For pending users: open chat automatically.
  useEffect(() => {
    const role = String(authStatus.user?.role ?? '').toLowerCase();
    if (authStatus.loggedIn && role === 'pending' && canChat && !chatOpen) setChatOpen(true);
  }, [authStatus.loggedIn, authStatus.user?.role, canChat, chatOpen]);

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
    const id = setInterval(() => void tick(), 2000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [authStatus.loggedIn, canChat, viewMode]);

  // Gate: если вкладка скрылась по permissions — переключаем на первую доступную.
  useEffect(() => {
    if (tab === 'engine' || tab === 'request' || tab === 'part' || tab === 'employee' || tab === 'contract') return;
    if (visibleTabs.includes(tab) || tab === userTab) return;
    setTab(visibleTabs[0] ?? 'auth');
  }, [tab, visibleTabsKey, userTab]);

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
    const id = setInterval(() => void poll(), 2000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  async function refreshEngines() {
    const list = await window.matrica.engines.list();
    setEngines(list);
  }

  async function openEngine(id: string) {
    setSelectedEngineId(id);
    setTab('engine');
    const d = await window.matrica.engines.get(id);
    setEngineDetails(d);
    const o = await window.matrica.operations.list(id);
    setOps(o);
  }

  async function openRequest(id: string) {
    setSelectedRequestId(id);
    setTab('request');
  }

  async function openContract(id: string) {
    setSelectedContractId(id);
    setTab('contract');
  }

  async function openPart(id: string) {
    setSelectedPartId(id);
    setTab('part');
  }

  async function openEmployee(id: string) {
    setSelectedEmployeeId(id);
    setTab('employee');
  }

  async function navigateDeepLink(link: any) {
    const tabId = String(link?.tab ?? '') as any;
    const engineId = link?.engineId ? String(link.engineId) : null;
    const requestId = link?.requestId ? String(link.requestId) : null;
    const partId = link?.partId ? String(link.partId) : null;
    const contractId = link?.contractId ? String(link.contractId) : null;
    const employeeId = link?.employeeId ? String(link.employeeId) : null;

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
    if (contractId) {
      await openContract(contractId);
      return;
    }
    if (employeeId) {
      await openEmployee(employeeId);
      return;
    }
    setTab(tabId);
  }

  function shortId(id: string | null) {
    if (!id) return '';
    return id.length > 10 ? `${id.slice(0, 8)}…` : id;
  }

  function buildChatBreadcrumbs() {
    const labels: Record<string, string> = {
      masterdata: 'Справочники',
      contracts: 'Контракты',
      contract: 'Карточка контракта',
      changes: 'Изменения',
      engines: 'Двигатели',
      engine: 'Карточка двигателя',
      requests: 'Заявки',
      request: 'Карточка заявки',
      parts: 'Детали',
      part: 'Карточка детали',
      employees: 'Сотрудники',
      employee: 'Карточка сотрудника',
      reports: 'Отчёты',
      admin: 'Админ',
      audit: 'Журнал',
      settings: 'Настройки',
      auth: 'Вход',
    };
    const parent: Record<string, string> = {
      engine: 'Двигатели',
      request: 'Заявки',
      part: 'Детали',
      contract: 'Контракты',
      employee: 'Сотрудники',
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
    if (tab === 'request' && selectedRequestId) crumbs.push(`ID ${shortId(selectedRequestId)}`);
    if (tab === 'part' && selectedPartId) crumbs.push(`ID ${shortId(selectedPartId)}`);
    if (tab === 'contract' && selectedContractId) crumbs.push(`ID ${shortId(selectedContractId)}`);
    if (tab === 'employee' && selectedEmployeeId) crumbs.push(`ID ${shortId(selectedEmployeeId)}`);

    return crumbs.filter(Boolean);
  }

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
    const link = {
      kind: 'app_link',
      tab,
      engineId: selectedEngineId ?? null,
      requestId: selectedRequestId ?? null,
      partId: selectedPartId ?? null,
      contractId: selectedContractId ?? null,
      employeeId: selectedEmployeeId ?? null,
      breadcrumbs: buildChatBreadcrumbs(),
    };
    const r = await window.matrica.chat
      .sendDeepLink({ recipientUserId: chatContext.selectedUserId ?? null, link })
      .catch(() => null);
    if (r && (r as any).ok && !viewMode) void window.matrica.sync.run().catch(() => {});
  }

  async function reloadEngine() {
    if (!selectedEngineId) return;
    const d = await window.matrica.engines.get(selectedEngineId);
    setEngineDetails(d);
    const o = await window.matrica.operations.list(selectedEngineId);
    setOps(o);
  }

  async function refreshAudit() {
    const a = await window.matrica.audit.list();
    setAudit(a);
  }

  const pageTitle =
    tab === 'engines'
      ? 'Матрица РМЗ — Двигатели'
      : tab === 'engine'
        ? 'Матрица РМЗ — Карточка двигателя'
        : tab === 'changes'
          ? 'Матрица РМЗ — Изменения'
        : tab === 'requests'
          ? 'Матрица РМЗ — Заявки'
          : tab === 'request'
            ? 'Матрица РМЗ — Заявка'
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

  function formatSyncStatusRu(s: SyncStatus | null): { text: string; isError: boolean } {
    if (viewMode) return { text: 'Синхр: ОТКЛ (режим просмотра резервной копии)', isError: true };
    if (!s) return { text: 'Синхр: … | последн.: — | следующий через —', isError: false };
    const stateLabel = s.state === 'idle' ? 'OK' : s.state === 'syncing' ? 'СИНХР' : 'ОШИБКА';
    const last = s.lastSyncAt ? new Date(s.lastSyncAt).toLocaleTimeString('ru-RU') : '—';
    const next =
      s.nextAutoSyncInMs == null
        ? '—'
        : s.nextAutoSyncInMs >= 60_000
          ? `${Math.ceil(s.nextAutoSyncInMs / 60_000)} мин.`
          : `${Math.ceil(s.nextAutoSyncInMs / 1000)} сек.`;
    return {
      text: `Синхр: ${stateLabel} | последн.: ${last} | следующий через ${next}`,
      isError: s.state === 'error',
    };
  }

  return (
    <Page
      title={pageTitle}
      uiTheme={resolvedTheme}
      right={
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', justifyContent: 'flex-end' }}>
          {authStatus.loggedIn && canChat && !chatOpen && (
            <Button
              variant="ghost"
              onClick={() => setChatOpen(true)}
              title="Открыть окно чата"
            >
              Открыть Чат
              {chatUnreadTotal > 0 ? (
                <span style={{ marginLeft: 6, color: 'var(--danger)', fontWeight: 900 }}>
                  {chatUnreadTotal}
                </span>
              ) : null}
            </Button>
          )}
          {authStatus.loggedIn && canChat && (
            <Button variant="ghost" onClick={() => void sendCurrentPositionToChat()} title="Отправить ссылку на текущий раздел в текущий чат">
              Отправить ссылку
            </Button>
          )}
          {authStatus.loggedIn && caps.canUseSync && !viewMode && (
            <Button
              variant="ghost"
              onClick={() => void runSyncNow({ showStatusMessage: true })}
              disabled={syncStatus?.state === 'syncing'}
              title="Запустить синхронизацию вручную"
            >
              Синхронизировать сейчас
            </Button>
          )}
        </div>
      }
    >
      <div style={{ display: 'flex', gap: 10, height: '100%', minHeight: 0 }}>
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
              onHide={() => setChatOpen(false)}
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
            overflow: 'auto',
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
              if (t === 'audit') void refreshAudit();
            }}
            visibleTabs={visibleTabs}
            userLabel={userLabel}
            userTab={userTab}
            authStatus={presence ? { online: presence.online } : undefined}
          />

          <div style={{ marginTop: 14 }}>
            {postLoginSyncMsg && (
              <div
                style={{
                  marginBottom: 12,
                  padding: 10,
                  borderRadius: 12,
                  background: 'rgba(14, 116, 144, 0.16)',
                  color: 'var(--text)',
                }}
              >
                {postLoginSyncMsg}
              </div>
            )}
            {!authStatus.loggedIn && tab !== 'auth' && (
              <div style={{ color: 'var(--muted)' }}>Требуется вход.</div>
            )}

        {tab === 'engines' && (
          <EnginesPage
            engines={engines}
            onRefresh={refreshEngines}
            onOpen={openEngine}
            onCreate={async () => {
              const r = await window.matrica.engines.create();
              await window.matrica.engines.setAttr(r.id, 'engine_number', '');
              await window.matrica.engines.setAttr(r.id, 'engine_brand', '');
                    await refreshEngines();
              await openEngine(r.id);
                  }}
            canCreate={caps.canEditEngines}
            canDelete={caps.canEditEngines}
          />
        )}

        {tab === 'contracts' && (
          <ContractsPage
            onOpen={openContract}
            canCreate={caps.canEditMasterData}
          />
        )}

        {tab === 'requests' && (
          <SupplyRequestsPage
            onOpen={openRequest}
            canCreate={caps.canCreateSupplyRequests}
            canDelete={caps.canEditSupplyRequests}
          />
        )}

        {tab === 'engine' && selectedEngineId && engineDetails && (
          <EngineDetailsPage
            key={selectedEngineId}
            engineId={selectedEngineId}
            engine={engineDetails}
            ops={ops}
            onReload={reloadEngine}
            onEngineUpdated={async () => {
              await refreshEngines();
              await reloadEngine();
            }}
            onAddOp={async (operationType, status, note) => {
              await window.matrica.operations.add(selectedEngineId, operationType, status, note);
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
          />
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
          />
        )}

        {tab === 'parts' && (
          <PartsPage
            onOpen={async (id) => {
              setSelectedPartId(id);
              setTab('part');
            }}
            canCreate={caps.canCreateParts}
          />
        )}

        {tab === 'employees' && (
          <EmployeesPage
            onOpen={async (id) => {
              setSelectedEmployeeId(id);
              setTab('employee');
            }}
            canCreate={caps.canManageEmployees}
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
            me={authStatus.user}
          />
        )}

        {tab === 'changes' && authStatus.loggedIn && authStatus.user && (
          <ChangesPage
            me={authStatus.user}
            canDecideAsAdmin={['admin', 'superadmin'].includes(String(authStatus.user.role ?? '').toLowerCase())}
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

        {tab === 'admin' && <div style={{ color: 'var(--muted)' }}>Раздел перемещён в карточку сотрудника.</div>}

        {tab === 'auth' && (
          <AuthPage
            onChanged={(s) => {
              setAuthStatus(s);
            }}
          />
        )}

        {tab === 'audit' && <AuditPage audit={audit} onRefresh={refreshAudit} />}

        {tab === 'engine' && (!selectedEngineId || !engineDetails) && (
          <div style={{ color: 'var(--muted)' }}>Выберите двигатель из списка.</div>
      )}

        {tab === 'contract' && !selectedContractId && (
          <div style={{ color: 'var(--muted)' }}>Выберите контракт из списка.</div>
        )}

        {tab === 'request' && !selectedRequestId && (
          <div style={{ color: 'var(--muted)' }}>Выберите заявку из списка.</div>
        )}

        {tab === 'part' && !selectedPartId && (
          <div style={{ color: 'var(--muted)' }}>Выберите деталь из списка.</div>
        )}

        {tab === 'employee' && !selectedEmployeeId && (
          <div style={{ color: 'var(--muted)' }}>Выберите сотрудника из списка.</div>
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
              onHide={() => setChatOpen(false)}
              onChatContextChange={(ctx) => setChatContext(ctx)}
              onNavigate={(link) => {
                void navigateDeepLink(link);
              }}
            />
          </div>
        )}
      </div>
    </Page>
  );
}


