// Ф2: настоящий мост window.matrica поверх портированного ядра. Вместо ручной
// реализации ~100 методов реюзаем НАСТОЯЩИЕ ipc/register/*-модули и preload
// Electron-клиента: электрон-шим даёт in-process ipcMain/ipcRenderer-шину, здесь
// собирается IpcContext и регистрируются домены android-рамки (план
// docs/plans/android-tablet-client-2026-08.md, Ф2).
//
// Промт КАРМАНА #142 (зачитка владельца 25.11.2026): «планшетная версия — полный
// функционал, все модули; версия для компьютера — копия планшетной». Значит список
// доменов десктопа и планшета должен совпадать, кроме оговорённого списка
// исключений — и исключение обязано называть причину (см. `core/tabletDomains.ts`).
// Домены, физически невозможные на планшете (файлы на диске, бэкапы, установщик
// обновления, перенос на десктоп, скрипты Windows-машины, почта), объявлены там
// же и НЕ регистрируются: иначе они ответили бы «недоступно на планшете» без
// причины — а это ровно тот неверный диагноз, который поставил владелец.
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import { ipcMain } from 'electron';

import { getSession } from '../../../electron-app/src/main/services/authService.js';
import type { IpcContext } from '../../../electron-app/src/main/ipc/ipcContext.js';
import { installSectionIpcGate } from '../../../electron-app/src/main/ipc/sectionGate.js';
import { createInProcessEngineListSource } from '../../../electron-app/src/main/services/engineListInProcess.js';
import { registerAdminIpc } from '../../../electron-app/src/main/ipc/register/admin.js';
import { registerAiAgentIpc } from '../../../electron-app/src/main/ipc/register/aiAgent.js';
import { registerAiChatIpc } from '../../../electron-app/src/main/ipc/register/aiChat.js';
import { registerAuthAndSyncIpc } from '../../../electron-app/src/main/ipc/register/authAndSync.js';
import { registerChangesIpc } from '../../../electron-app/src/main/ipc/register/changes.js';
import { registerChatIpc } from '../../../electron-app/src/main/ipc/register/chat.js';
import { registerDesktopTransferIpc } from '../../../electron-app/src/main/ipc/register/desktopTransfer.js';
import { registerChecklistsIpc } from '../../../electron-app/src/main/ipc/register/checklists.js';
import { registerChildrenIpc } from '../../../electron-app/src/main/ipc/register/children.js';
import { registerContractPaymentsIpc } from '../../../electron-app/src/main/ipc/register/contractPayments.js';
import { registerContractsIpc } from '../../../electron-app/src/main/ipc/register/contracts.js';
import { registerDraftsIpc } from '../../../electron-app/src/main/ipc/register/drafts.js';
import { registerEmployeesIpc } from '../../../electron-app/src/main/ipc/register/employees.js';
import { registerEngineActTemplatesIpc } from '../../../electron-app/src/main/ipc/register/engineActTemplates.js';
import { registerEngineReclamationsIpc } from '../../../electron-app/src/main/ipc/register/engineReclamations.js';
import { registerEnginesOpsAuditIpc } from '../../../electron-app/src/main/ipc/register/enginesOpsAudit.js';
import { registerEngineBulkIntakeIpc } from '../../../electron-app/src/main/ipc/register/engineBulkIntake.js';
import { registerEngineCardsIpc } from '../../../electron-app/src/main/ipc/register/engineCards.js';
import { registerErpIpc } from '../../../electron-app/src/main/ipc/register/erp.js';
import { registerLoggingIpc } from '../../../electron-app/src/main/ipc/register/logging.js';
import { registerMaintenanceIpc } from '../../../electron-app/src/main/ipc/register/maintenance.js';
import { registerNotesIpc } from '../../../electron-app/src/main/ipc/register/notes.js';
import { registerOrganizationIpc } from '../../../electron-app/src/main/ipc/register/organization.js';
import { registerPartsIpc } from '../../../electron-app/src/main/ipc/register/parts.js';
import { registerPpeIpc } from '../../../electron-app/src/main/ipc/register/ppe.js';
import { registerPrintFormsIpc } from '../../../electron-app/src/main/ipc/register/printForms.js';
import { registerProductionProgramIpc } from '../../../electron-app/src/main/ipc/register/productionProgram.js';
import { registerReportsIpc } from '../../../electron-app/src/main/ipc/register/reports.js';
import { registerScrapCriterionIpc } from '../../../electron-app/src/main/ipc/register/scrapCriterion.js';
import { registerEngineScrapIpc } from '../../../electron-app/src/main/ipc/register/engineScrap.js';
import { registerSectionFavoritesIpc } from '../../../electron-app/src/main/ipc/register/sectionFavorites.js';
import { registerServicePricingIpc } from '../../../electron-app/src/main/ipc/register/servicePricing.js';
import { registerSettingsIpc } from '../../../electron-app/src/main/ipc/register/settings.js';
import { registerSignatureDefaultsIpc } from '../../../electron-app/src/main/ipc/register/signatureDefaults.js';
import { registerSupplyRequestsIpc } from '../../../electron-app/src/main/ipc/register/supplyRequests.js';
import { registerSystemIpc } from '../../../electron-app/src/main/ipc/register/system.js';
import { registerTimesheetsIpc } from '../../../electron-app/src/main/ipc/register/timesheets.js';
import { registerToolsIpc } from '../../../electron-app/src/main/ipc/register/tools.js';
import { registerUiScreensIpc } from '../../../electron-app/src/main/ipc/register/uiScreens.js';
import { registerWarehouseLocationsIpc } from '../../../electron-app/src/main/ipc/register/warehouseLocations.js';
import { registerWorkOrderSignatureCaptionsIpc } from '../../../electron-app/src/main/ipc/register/workOrderSignatureCaptions.js';
import { registerWorkOrderTemplatesIpc } from '../../../electron-app/src/main/ipc/register/workOrderTemplates.js';
import { registerWorkOrdersIpc } from '../../../electron-app/src/main/ipc/register/workOrders.js';
import { registerWorkSheetsIpc } from '../../../electron-app/src/main/ipc/register/workSheets.js';
import { registerWorkshopsIpc } from '../../../electron-app/src/main/ipc/register/workshops.js';

import { getAndroidPlatformHooks } from '../shims/platform.js';
import { registerAndroidFilesIpc } from './filesBridge.js';
import { TABLET_CHANNEL_RULES } from './tabletDomains.js';
import type { AndroidCore } from './boot.js';

export function wireIpcForAndroid(core: AndroidCore): IpcContext {
  const db = core.serviceDb;

  async function currentActor(): Promise<string> {
    const s = await getSession(db).catch(() => null);
    const u = s?.user?.username;
    return u && u.trim() ? u.trim() : 'local';
  }

  async function currentViewer(): Promise<{ login: string; role: string }> {
    const s = await getSession(db).catch(() => null);
    return { login: String(s?.user?.username ?? '').trim(), role: String(s?.user?.role ?? '').trim() };
  }

  // Та же admin-поправка, что в десктопном registerIpc: backend шлёт только
  // masterdata.view — карточки админа должны оставаться редактируемыми.
  async function currentPermissions(): Promise<Record<string, boolean>> {
    const s = await getSession(db).catch(() => null);
    const perms = { ...((s?.permissions ?? {}) as Record<string, boolean>) };
    const role = String(s?.user?.role ?? '').trim().toLowerCase();
    if ((role === 'admin' || role === 'superadmin') && perms['masterdata.view'] === true) {
      perms['masterdata.edit'] = true;
    }
    return perms;
  }

  const ctx: IpcContext = {
    sysDb: db,
    dataDb: (): BetterSQLite3Database => db, // режима «просмотр бэкапа» на планшете нет
    mode: () => ({ mode: 'live' as const }),
    mgr: core.syncManager,
    // Отдельного процесса чтений на планшете нет (`utilityProcess` — механизм Electron):
    // список собирается здесь, как до переезда. Форма одна с десктопом, чтобы обработчик
    // `engine:list` не обрастал ветками по платформе.
    engineList: createInProcessEngineListSource({ db: () => db }),
    logToFile: (message: string) => console.info(`[android-main] ${message}`),
    currentActor,
    currentViewer,
    currentPermissions,
  };

  const restoreIpcHandle = installSectionIpcGate(ctx);
  registerLoggingIpc(ctx);
  registerAuthAndSyncIpc(ctx);
  registerChangesIpc(ctx);
  registerEnginesOpsAuditIpc(ctx);
  // Карточки двигателей и пакетный приём (промт КАРМАНА #111: «вносим изменения в
  // карточку двигателя — ничего не сохраняется, на сервер не уходит»).
  //
  // Причина была не в правах: домен просто НЕ был зарегистрирован в мосте
  // планшета, и preload отдавал функции, для которых в шине нет хэндлера —
  // шим отвечал «недоступно на планшете: engines:card:save», и запись не
  // доходила ни до локальной БД, ни до очереди push'а.
  //
  // Запись карточки — локальная реплика со `sync_status='pending'`, уходит
  // push'ом (тот же путь, что у десктопа), так что офлайн-правка в цеху
  // доезжает до сервера при следующем синке.
  registerEngineCardsIpc(ctx);
  registerEngineBulkIntakeIpc(ctx);
  registerDraftsIpc(ctx);
  registerEmployeesIpc(ctx);
  registerAdminIpc(ctx);
  registerChecklistsIpc(ctx);
  registerEngineActTemplatesIpc(ctx);
  registerWorkshopsIpc(ctx);
  registerSupplyRequestsIpc(ctx);
  // Ф3 — наряды и склад. Локально-офлайн: workOrderService (локальная БД) и
  // складские документы (warehouseCommandOutbox). Сборочные действия
  // (issue/post/close) и справочники шаблонов/подписей ходят по HTTP — на
  // планшете это штатный «нужна сеть», как на десктопе.
  registerWorkOrdersIpc(ctx);
  registerWorkOrderTemplatesIpc(ctx);
  registerWorkOrderSignatureCaptionsIpc(ctx);
  registerWarehouseLocationsIpc(ctx);
  // Этапы работ: плитка на планшете есть с 3.33.0, а домен подключён не был —
  // вкладка открывалась и молча не работала. Строки живут в локальной реплике
  // (офлайн), справочник узлов — REST, как наряды: «нужна сеть» здесь штатно.
  registerWorkSheetsIpc(ctx);
  registerSettingsIpc(ctx);
  // Звёздочки разделов (избранное левой панели). Без этого домена звёздочка в меню
  // нажималась, а раздел в левый блок не попадал: канал не был зарегистрирован,
  // запись возвращала «недоступно на планшете», и оболочка откатывала выбор.
  // Хранение локальное (как на десктопе) — в локальной БД планшета, по scope пользователя.
  registerSectionFavoritesIpc(ctx);
  registerNotesIpc(ctx);
  registerPartsIpc(ctx);
  registerErpIpc(ctx);
  // Производственная программа (промт КАРМАНА #70, п.4): план на планшете.
  // Чтение — из локальной реплики (работает без сети), запись — серверной дверью
  // REST (как на десктопе: «нужна сеть» здесь штатно).
  registerProductionProgramIpc(ctx);
  // «№ в договоре» в плане ПП тянется из карточки договора: домен «Договоры»
  // нужен странице. Права и гейт раздела — те же, что на десктопе (server решает).
  registerContractsIpc(ctx);
  // Вложения: свой узкий мост поверх REST (десктопный files.ts построен вокруг
  // путей на диске и на планшете неприменим).
  registerAndroidFilesIpc(ctx);

  // ── Полнота планшетной версии (промт КАРМАНА #142) ────────────────────────
  //
  // Домены, которых на планшете не было (отчёты, табель, СИЗ, инструменты,
  // рекламации двигателей, печатные формы, платежи по контрактам, цены на
  // услуги, подписи по умолчанию, чат, ИИ-агент, почта, экспорт, файловый
  // поиск, бэкапы, обслуживание, обновление, экраны UI, перенос на десктоп,
  // критерии утиля, дети, организация) — владелец видел это как «недостаточно
  // прав», а на самом деле канал просто не был заведён в мосте: шим отвечал
  // «недоступно на планшете», renderer печатал «Ошибка сохранения: …», и
  // оператор решал, что запись не уходит.
  //
  // Ниже — домены, которые на планшете работают. Те, что физически невозможны
  // (файлы на диске, бэкапы, установщик обновления, перенос на десктоп, почта,
  // выгрузка 1С), объявлены исключениями в `core/tabletDomains.ts` — с
  // причиной, а не молча.
  //
  // ⚠ Регистрация идёт ДО снятия гейта разделов (`restoreIpcHandle`): иначе
  // новые домены прошли бы мимо «доступа по разделам», и на планшете стало бы
  // видно то, что на компьютере скрыто (заказ владельца от 24.11: «уровни
  // доступа по пользователям на планшете такие же, как на компьютере»).
  registerReportsIpc(ctx);
  registerTimesheetsIpc(ctx);
  registerPpeIpc(ctx);
  registerToolsIpc(ctx);
  registerEngineReclamationsIpc(ctx);
  registerPrintFormsIpc(ctx);
  registerContractPaymentsIpc(ctx);
  registerServicePricingIpc(ctx);
  registerSignatureDefaultsIpc(ctx);
  registerChatIpc(ctx);
  // Передача файлов между Верстаками (промт КАРМАНА #143). Исключение «планшет не
  // десктоп» было устаревшим: транспорт — личное сообщение чата с файлом, а НЕ
  // локальная сеть, и путь на диске не нужен — нужен id файла, уже залитого в
  // программу (на планшете его заливает `files:uploadBlob`). Без этого домена
  // оператор с планшета не мог ни отправить файл коллеге, ни принять присланный.
  registerDesktopTransferIpc(ctx);
  registerAiAgentIpc(ctx);
  registerAiChatIpc(ctx);
  registerUiScreensIpc(ctx);
  registerScrapCriterionIpc(ctx);
  // Снятие утиля двигателя (промт КАРМАНА #170): гейт «утильный двигатель не начинает
  // ремонт» живёт в общей воронке записи этапа, а окно с двумя действиями зовёт этот домен.
  // Без него на планшете шим ответил бы «недоступно на планшете: engines:scrap:resolve» —
  // и оператор не смог бы снять утиль, чтобы завести этап. Возврат детали в ремонтный
  // фонд ходит по HTTP (как на десктопе): без сети снятие утиля всё равно пишет след.
  registerEngineScrapIpc(ctx);
  registerChildrenIpc(ctx);
  registerOrganizationIpc(ctx);
  registerMaintenanceIpc(ctx);
  registerSystemIpc(ctx);
  restoreIpcHandle();

  // Каналы ЗАРЕГИСТРИРОВАННЫХ доменов, которые на планшете физически не
  // работают (печать/PDF считаются в скрытом окне Electron; синх часов —
  // служба времени Windows). Их отказ обязан называть причину, а не выглядеть
  // как «нет доступа»: перекрываем ПОСЛЕ снятия гейта разделов, иначе отказ по
  // разделу замаскировал бы настоящую причину.
  for (const rule of TABLET_CHANNEL_RULES) {
    ipcMain.handle(rule.channel, async () => ({
      ok: false as const,
      error: `на планшете не работает: ${rule.channel} — ${rule.reason}`,
    }));
  }

  // Каналы, живущие в electron-app/src/main/index.ts (не портируется целиком).
  ipcMain.handle('app:ping', async () => 'pong');
  // Форма ответа — как в Electron (`{ ok, version }`), а не голая строка: экраны проверяют
  // `v?.ok && v.version`, и строка молча читалась как «версии нет» — на планшете в настройках
  // стоял прочерк, хотя версия сборки была на месте.
  ipcMain.handle('app:version', async () => ({ ok: true, version: getAndroidPlatformHooks().appVersion() }));

  return ctx;
}

/**
 * Полная установка моста: регистрация хэндлеров + настоящий preload
 * (contextBridge-шим кладёт window.matrica). Порядок обязателен — preload
 * исполняется на импорте и должен видеть готовую шину только в момент вызовов,
 * но wiring до него держит инварианты простыми.
 */
export async function installAndroidBridge(core: AndroidCore): Promise<IpcContext> {
  const ctx = wireIpcForAndroid(core);
  await import('../../../electron-app/src/preload/index.js');
  return ctx;
}
