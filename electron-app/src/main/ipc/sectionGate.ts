/**
 * Ф2 «доступа по разделам» (plan docs/plans/section-access-2026-07.md): энфорс
 * НА ПРИЛОЖЕНИИ (решение владельца 2026-07-02 — сохраняем модель «полная база на
 * каждом клиенте», как у закрытых нарядов; sync не фильтруем). Main-процесс
 * отказывает в IPC-чтении данных раздела, в котором авторизованный пользователь
 * не состоит, — меню Ф1 прячет плитки, гейт закрывает обход UI.
 *
 * Fail-open по построению: superadmin, незасеянный membership (legacy),
 * не-залогинен (каналы и так требуют сессию), незамапленный канал/тип — всё
 * пропускается. Уровень editor (запрет записи наблюдателю) — Ф3.
 */
import { ipcMain } from 'electron';
import { and, eq, isNull } from 'drizzle-orm';

import {
  accessSectionMeta,
  canEditSection,
  canViewSection,
  type AccessSection,
  type SectionMembership,
} from '@matricarmz/shared';

import type { IpcContext } from './ipcContext.js';
import { EMPLOYEE_SIZE_ATTR_CODES } from '@matricarmz/shared';
import { getSectionMembershipByLoginWithSource, type SectionMembershipSource } from '../services/employeeService.js';
import { entities, entityTypes } from '../database/schema.js';

// Longest-prefix wins (порядок не важен — выбираем самое длинное совпадение).
const PREFIX_RULES: ReadonlyArray<readonly [string, AccessSection]> = [
  ['engine:', 'production'],
  ['engines:', 'production'],
  // Поиск по файлам работает с данными двигателей — раздел тот же.
  ['fileSearch:', 'production'],
  ['ops:', 'production'],
  ['workSheets:', 'production'],
  // Производственная программа (ПП) — свой раздел (владелец 21.11.2026): план читает
  // весь завод, а пишет его узкий круг. Наблюдатель видит план (viewer), править его
  // может только editor этого раздела — тем же гейтом, что и остальные разделы.
  ['productionProgram:', 'production_program'],
  ['parts:', 'production'],
  ['checklists:', 'production'],
  ['warehouse:assemblyBom:', 'production'],
  ['warehouse:repairNorm:', 'production'],
  ['warehouse:engineInstances:', 'production'],
  ['workOrders:', 'work_orders'],
  ['workOrderTemplates:', 'work_orders'],
  ['signatureCaptions:', 'work_orders'],
  ['supplyRequests:', 'supply'],
  ['warehouse:contracts:', 'contracts'],
  ['contractPayments:', 'contracts'],
  ['contracts:', 'contracts'],
  ['warehouse:', 'warehouse'],
  ['warehouseLocations:', 'warehouse'],
  ['ppe:', 'warehouse'],
  // Умолчания подписей (PR-5): кнопка живёт в актах двигателя (производство);
  // запись — только админам (дверь REST проверяет роль, это вторая линия).
  ['signatureDefaults:', 'production'],
  // employees:list/get/defs/departments — сквозные lookup'ы (наряды, чат, табель,
  // инструмент) — НЕ гейтим; закрываем только управление карточками/правами.
  ['employees:setAttr', 'people'],
  ['employees:create', 'people'],
  ['employees:delete', 'people'],
  ['employees:merge', 'people'],
  ['employees:permissionsGet', 'people'],
  ['employees:sectionMembershipGet', 'people'],
  ['employees:resyncFromServer', 'people'],
  // Организационный отдел (мероприятия, журнал выдачи) — общий раздел: видят все, кто
  // работает в программе, ведёт хозяин модуля. Каналов этого модуля в гейте не было
  // вовсе — данные читались мимо разделов.
  ['organization:', 'organization'],
  // Дети — закрытый раздел (владелец 21.11.2026): карточки детей и данные о них
  // видят только суперадмин и хозяин модуля.
  ['children:', 'children'],
  // timesheets:* — без гейта по разделу (владелец 13.11.2026): табель доступен всем,
  // кто работает в программе; править свой табель может только автор (гейт на сервере).
  ['reports:', 'reports'],
  ['reportsBuilder:', 'reports'],
  // Модуль печатных форм — тот же раздел доступа, что и отчёты (раздел «Печатные
  // формы» живёт в разделе «Отчёты и аналитика»): без записи в PREFIX_RULES его
  // каналы проходили мимо гейта разделов, и раздел был виден не всем, кому выдан.
  // Уровень editor на запись НЕ требуем: свой личный шаблон и свои документы
  // доступны и наблюдателю раздела (как с табелем — границу держит право и сервер).
  ['printForms:', 'reports'],
  ['workshops:stats', 'reports'],
  // workshops:list — lookup цехов из чужих карточек; гейтим только управление.
  ['workshops:upsert', 'directories'],
  ['workshops:delete', 'directories'],
  ['maintenance:', 'directories'],
  // Гейтим только чтение журнала. `audit:add` — телеметрия интерфейса (uiUsageLog), её пишет
  // КАЖДЫЙ пользователь; под префиксом `audit:` она отбивалась у всех, кто не состоит в
  // «Администрировании», и журнал действий был слеп к половине парка (3.1.0 → 10.09.2026).
  ['audit:list', 'administration'],
];
// НЕ гейтятся сознательно: `tools:` (один namespace на справочник инструментов
// production и учёт выдач supply); lookup-чтения employees/workshops (см. выше).
// Сквозные связки разделов (member одного раздела читает данные другого):
// договоры → производство (engine:list в карточке договора), склад →
// договоры/контрагенты (warehouse:lookups:get) — при ручном сужении матрицы
// владельцем эти пары надо сужать согласованно (см. план §Ф2).

// Generic admin:* каналы гейтятся по entity-type сущности. Мапим только
// чувствительные типы; незамапленный тип (справочники-lookup'ы, использующиеся
// из чужих карточек) — пропуск, чтобы не ломать сценарии других разделов.
export const ENTITY_TYPE_SECTION: Readonly<Record<string, AccessSection>> = {
  contract: 'contracts',
  // Тип контрагента называется `customer` — так он заведён в базе и так его
  // гейтит сервер (LEDGER_SECTION_BY_ENTITY_TYPE). Ключ `counterparty`, стоявший
  // здесь раньше, не совпадал ни с чем: гейт по карточкам контрагентов не
  // срабатывал вовсе, и viewer раздела «Договоры» правил их беспрепятственно.
  customer: 'contracts',
  employee: 'people',
  engine: 'production',
  engine_brand: 'production',
  engine_brand_group: 'production',
};

/**
 * Типы, которых нет в серверной карте намеренно: сервер гейтит их иначе или не
 * гейтит вовсе, но клиенту закрыть их полезно. Список существует ради сторожа
 * `sectionGateEntityTypes.guard.test.ts`: всё остальное в карте обязано совпадать
 * с серверным именем типа, иначе опечатка тихо отключает гейт.
 */
export const CLIENT_ONLY_GATED_ENTITY_TYPES: readonly string[] = ['engine_brand_group'];

// Мутирующие каналы гейтящихся разделов (Ф3): наблюдателю (viewer) — отказ,
// нужен editor. Только явный список — verb-эвристика ловила бы личные
// настройки (reports:favoritesSet) и read-каналы (warehouse:documents:plan).
const WRITE_CHANNELS = new Set([
  // production
  'engine:create',
  'engine:delete',
  'engine:setAttr',
  'engine:dedupe:merge',
  'engines:card:save',
  // Снятие утиля двигателя (промт КАРМАНА #170): меняет состояние движка (флаги карточки
  // и след в истории ремонта) — идёт через write-гейт раздела, как остальные записи.
  'engines:scrap:resolve',
  'ops:add',
  'ops:delete',
  'ops:updateManual',
  'parts:create',
  'parts:delete',
  'parts:updateAttribute',
  'parts:partBrandLinks:delete',
  'warehouse:assemblyBom:upsert',
  'warehouse:assemblyBom:delete',
  'warehouse:assemblyBom:archive',
  'warehouse:assemblyBom:activateDefault',
  'warehouse:assemblyBom:schema:set',
  'warehouse:repairNorm:upsert',
  'warehouse:engineInstances:upsert',
  'warehouse:engineInstances:delete',
  'workSheets:types:upsert',
  'workSheets:types:archive',
  'workSheets:types:restore',
  'workSheets:rows:save',
  'workSheets:rows:delete',
  // Производственная программа: план ведут трое (уровень editor этого раздела),
  // наблюдатель читает. Границу держит и серверное право `production_program.edit`.
  'productionProgram:create',
  'productionProgram:update',
  'productionProgram:saveRows',
  'productionProgram:remove',
  'productionProgram:setRowOperatorNote',
  // Шаблон подписей ПП по умолчанию (промт КАРМАНА #120): общий для завода
  // набор подписей. Правит его не тот, кто ведёт план, а владелец шаблона —
  // границу держит и серверное право `production_program.signature_templates.edit`.
  'productionProgram:saveSignatureTemplate',
  'productionProgram:deleteSignatureTemplate',
  // work_orders
  'workOrders:create',
  'workOrders:update',
  'workOrders:setNumber',
  'workOrders:delete',
  'workOrders:close',
  'workOrders:assemblyReturn',
  'workOrders:postAssembly',
  'workOrders:saveAssemblyDraft',
  'workOrders:issueAssembly',
  'workOrders:setIssuedState',
  'workOrders:requestAssemblyShortageApproval',
  'workOrders:decideAssemblyShortageApproval',
  'workOrders:deleteAssemblyDraft',
  'workOrderTemplates:delete',
  'signatureCaptions:add',
  // supply
  'supplyRequests:create',
  'supplyRequests:update',
  'supplyRequests:delete',
  'supplyRequests:transition',
  // contracts
  'contractPayments:save',
  'contracts:counterparty:save',
  'contracts:counterparty:create',
  'contracts:contract:save',
  'contracts:contract:create',
  // warehouse
  'warehouse:directoryPart:create',
  'warehouse:documents:create',
  'warehouse:documents:cancel',
  'warehouse:documents:post',
  'warehouse:nomenclature:upsert',
  'warehouse:nomenclature:delete',
  'warehouse:nomenclature:itemTypes:upsert',
  'warehouse:nomenclature:itemTypes:delete',
  'warehouse:nomenclature:partSpec:update',
  'warehouse:nomenclature:properties:upsert',
  'warehouse:nomenclature:properties:delete',
  'warehouse:nomenclature:templates:upsert',
  'warehouse:nomenclature:templates:delete',
  'warehouse:partsDedupe:merge',
  'warehouse:repairFund:intake',
  'warehouse:scrap:intake',
  'ppe:norms:upsert',
  'ppe:normLines:wearPeriod:set',
  'ppe:cards:open',
  'ppe:cards:assignNorms',
  // Набор норм из карточки СИЗ (промты КАРМАНА #21/#26): заводится новый набор и
  // сразу назначается карточке — пишет в карточку, значит идёт через write-гейт.
  'ppe:cards:createNormSet',
  'ppe:cards:close',
  'ppe:cards:issue',
  // Возврат СИЗ (миграция 0126): «получил обратно» и снятие отметки — пишут в
  // карточку выдачи, значит идут через write-гейт раздела, как остальные каналы СИЗ.
  'ppe:issueEntries:markReturned',
  'ppe:issueEntries:undoReturn',
  // Кладовщик фаза 2 (финальный проход #166, 2026-10-16): каналы новой половины
  // модуля в список не попали, и наблюдатель раздела правил отпуска/группы/
  // коллективные/импорт мимо гейта, тогда как фаза 1 была закрыта. Список
  // держит `sectionGateWriteChannels.guard.test.ts` — он сканирует регистрацию.
  'ppe:absences:create',
  'ppe:absences:delete',
  'ppe:groups:create',
  'ppe:groups:delete',
  'ppe:groups:members:set',
  'ppe:groups:norms:set',
  'ppe:collectives:open',
  'ppe:collectives:distribute',
  'ppe:collectives:close',
  'ppe:duty:issue',
  // preview не пишет, но открывает 30-минутное окно применения и на сервере
  // уже требует права правки — наблюдателю он незачем.
  'ppe:import:preview',
  'ppe:import:apply',
  // Приказ о СИЗ (Минтруд 767н): личная карточка по форме приложения №3 и шаблоны
  // печатных форм. Наблюдателю раздел «Склад» их править нельзя.
  'ppe:employees:card:update',
  'ppe:printTemplates:save',
  'ppe:printTemplates:delete',
  // Остатки склада СИЗ по отчёту: импорт проводит складской документ —
  // наблюдателю раздел «Склад» его проводить нельзя.
  'ppe:stockImport:preview',
  'ppe:stockImport:apply',
  // Умолчания подписей (PR-5): наблюдателю — отказ, нужен editor раздела.
  'signatureDefaults:set',
  'warehouseLocations:delete',
  'warehouseLocations:registerUsage',
  // people
  'employees:setAttr',
  'employees:create',
  'employees:delete',
  'employees:merge',
  'employees:resyncFromServer',
  // Табели (timesheets:*) в разделе «Персонал» больше не гейтятся (владелец 13.11.2026):
  // табель заводит и смотрит каждый, а править свой табель может только автор —
  // этот гейт держит сервер (timesheetService.canEditTimesheet), а не раздел.
  // directories
  'workshops:upsert',
  'workshops:delete',
  'maintenance:emptyCards:delete',
  // Детский и организационный модули (владелец 21.11.2026): организационный отдел ведёт
  // хозяин модуля (editor раздела), «Дети» — он же и суперадмин. Наблюдатель
  // организационного отдела читает, но править не может.
  'children:save',
  'children:remove',
  'organization:saveEvent',
  'organization:removeEvent',
  'organization:saveGift',
  'organization:removeGift',
]);

const TYPE_ARG_CHANNELS = new Set([
  'admin:entities:listByEntityType',
  'admin:entities:create',
  'admin:attributeDefs:listByEntityType',
]);
const ENTITY_ARG_CHANNELS = new Set([
  'admin:entities:get',
  'admin:entities:setAttr',
  'admin:entities:softDelete',
  'admin:entities:deleteInfo',
  'admin:entities:incomingReferences',
  'admin:entities:resolveAndDelete',
  'admin:entities:detachLinksAndDelete',
]);
// Мутирующее подмножество generic admin:* каналов (Ф3 — требуют editor).
const ADMIN_WRITE_CHANNELS = new Set([
  'admin:entities:create',
  'admin:entities:setAttr',
  'admin:entities:softDelete',
  'admin:entities:resolveAndDelete',
  'admin:entities:detachLinksAndDelete',
]);

export function matchPrefixRule(channel: string): AccessSection | null {
  let best: readonly [string, AccessSection] | null = null;
  for (const rule of PREFIX_RULES) {
    if (channel.startsWith(rule[0]) && (!best || rule[0].length > best[0].length)) best = rule;
  }
  return best ? best[1] : null;
}

/** Канал требует права редактора раздела (мутирующий). Экспорт — для сторожа регистрации. */
export function isWriteGatedChannel(channel: string): boolean {
  return WRITE_CHANNELS.has(channel) || ADMIN_WRITE_CHANNELS.has(channel);
}

export function createSectionIpcGate(ctx: IpcContext) {
  // Membership-кэш: гейт стоит на каждом IPC-вызове, скан EAV на каждый — дорого.
  // Вместе со значением кэшируем ИСТОЧНИК: «реплика» или «замороженное EAV-зеркало».
  // Источник решает, что сказать оператору при отказе (см. refuseMessage).
  let membershipCache: {
    login: string;
    value: SectionMembership | null;
    source: SectionMembershipSource;
    at: number;
  } | null = null;
  const MEMBERSHIP_TTL_MS = 15_000;

  async function membershipFor(login: string): Promise<{
    value: SectionMembership | null;
    source: SectionMembershipSource;
  }> {
    const now = Date.now();
    if (membershipCache && membershipCache.login === login && now - membershipCache.at < MEMBERSHIP_TTL_MS) {
      return { value: membershipCache.value, source: membershipCache.source };
    }
    const read = await getSectionMembershipByLoginWithSource(ctx.dataDb(), login).catch(() => ({
      membership: null,
      source: 'none' as SectionMembershipSource,
    }));
    membershipCache = { login, value: read.membership, source: read.source, at: now };
    return { value: read.membership, source: read.source };
  }

  async function isAllowed(sectionId: AccessSection, level: 'viewer' | 'editor'): Promise<boolean> {
    const viewer = await ctx.currentViewer();
    if (!viewer.login) return true; // не залогинен — auth-контроль на самих хэндлерах
    if (String(viewer.role ?? '').toLowerCase() === 'superadmin') return true;
    const membership = await membershipFor(viewer.login.toLowerCase());
    if (membership.value == null) return true; // не засеяно (legacy) — fail-open
    const check = level === 'editor' ? canEditSection : canViewSection;
    return check({ membership: membership.value, role: viewer.role, sectionId });
  }

  const typeCodeCache = new Map<string, string>(); // entityTypeId → code (типы неизменны в рамках сессии)
  async function typeCodeById(entityTypeId: string): Promise<string | null> {
    const cached = typeCodeCache.get(entityTypeId);
    if (cached != null) return cached;
    const rows = await ctx
      .dataDb()
      .select({ code: entityTypes.code })
      .from(entityTypes)
      .where(and(eq(entityTypes.id, entityTypeId), isNull(entityTypes.deletedAt)))
      .limit(1);
    const code = rows[0]?.code ? String(rows[0].code) : null;
    if (code) typeCodeCache.set(entityTypeId, code);
    return code;
  }

  async function sectionForEntityArgs(channel: string, args: unknown[]): Promise<AccessSection | null> {
    try {
      let typeId: string | null = null;
      if (TYPE_ARG_CHANNELS.has(channel)) {
        typeId = String(args[0] ?? '').trim() || null;
      } else if (ENTITY_ARG_CHANNELS.has(channel)) {
        const entityId = String(args[0] ?? '').trim();
        if (!entityId) return null;
        const rows = await ctx
          .dataDb()
          .select({ typeId: entities.typeId })
          .from(entities)
          .where(eq(entities.id, entityId))
          .limit(1);
        typeId = rows[0]?.typeId ? String(rows[0].typeId) : null;
      }
      if (!typeId) return null;
      const code = await typeCodeById(typeId);
      return code ? (ENTITY_TYPE_SECTION[code] ?? null) : null;
    } catch {
      return null; // диагностика типа не должна ронять вызов — fail-open
    }
  }

  /**
   * Узкое исключение из гейта раздела: запись УЗКИХ полей карточки сотрудника.
   *
   * Кладовщику (решения владельца 03.11.2026 и 19.11.2026) нужно править должность
   * (чтобы норма приказа подобралась) и фактические размеры (он меряет сотрудника
   * при выдаче СИЗ). Editor'а раздела «Персонал» у него нет — и не нужно: кадровую
   * карточку он не ведёт. Право узкое, проверяет его сам обработчик.
   */
  async function isNarrowEmployeeWrite(channel: string, args: unknown[]): Promise<boolean> {
    if (channel !== 'employees:setAttr') return false;
    const attrCode = String(args[1] ?? '').trim().toLowerCase();
    const perms = await ctx.currentPermissions().catch(() => ({}) as Record<string, boolean>);
    if (attrCode === 'role') return perms['employees.position.edit'] === true;
    if (EMPLOYEE_SIZE_ATTR_CODES.includes(attrCode)) return perms['employees.sizes.edit'] === true;
    return false;
  }

  /** Обернуть handler канала section-гейтом (или вернуть как есть, если канал не гейтится). */
  function wrap(channel: string, handler: (...a: any[]) => any): (...a: any[]) => any {
    const prefixSection = matchPrefixRule(channel);
    const entityGated = TYPE_ARG_CHANNELS.has(channel) || ENTITY_ARG_CHANNELS.has(channel);
    if (!prefixSection && !entityGated) return handler;
    const level: 'viewer' | 'editor' = isWriteGatedChannel(channel) ? 'editor' : 'viewer';
    return async (event: unknown, ...args: unknown[]) => {
      if (await isNarrowEmployeeWrite(channel, args)) return handler(event, ...args);
      const sectionId = prefixSection ?? (await sectionForEntityArgs(channel, args));
      if (sectionId && !(await isAllowed(sectionId, level))) {
        const title = accessSectionMeta(sectionId)?.titleRu ?? sectionId;
        throw new Error(await refuseMessage(sectionId, level, title));
      }
      return handler(event, ...args);
    };
  }

  /**
   * Что сказать оператору при отказе по разделу.
   *
   * Разные источника membership дают РАЗНЫЕ отказы — и разница видна невооружённым
   * глазом:
   *
   * 1. Ответ из реплики (`users ⋈ user_section_access`) авторитетен: раздела
   *    действительно нет → «обратитесь к администратору» — честно.
   * 2. Ответ из ЗАМОРОЖЕННОГО EAV-зеркала `section_access` (реплика на машине ещё
   *    не налита) авторитетен лишь наполовину: зеркало заморожено миграцией 0103,
   *    и разделов, выданных после неё, в нём нет НИ У КОГО. Отказывать и говорить
   *    «обратитесь к администратору» здесь — ложь: доступ может быть выдан, а
   *    клиент просто не знает. Правильный ответ — назвать настоящую причину:
   *    «данные о доступах на этом устройстве не обновлены».
   *
   * Права при этом НЕ расширяются: раздел остаётся закрытым, меняется только
   * объяснение. Решение владельца о судьбе самого EAV-зеркала (убрать или чинить)
   * — отдельный открытый вопрос (docs/pending/perekhodnaya-eav-vetka-oflayn-geyta-snyat-na-b6.md).
   */
  async function refuseMessage(
    sectionId: AccessSection,
    level: 'viewer' | 'editor',
    title: string,
  ): Promise<string> {
    const viewer = await ctx.currentViewer();
    const login = viewer.login ? viewer.login.toLowerCase() : '';
    const membership = login ? await membershipFor(login) : { value: null, source: 'none' as SectionMembershipSource };
    if (membership.source === 'legacy_eav') {
      return `Раздел «${title}» на этом устройстве пока недоступен: данные о доступах не обновлены (нужен синх). Права на сервере при этом не менялись.`;
    }
    return level === 'editor' && membership.value && (await isAllowed(sectionId, 'viewer'))
      ? `Раздел «${title}» доступен вам только для просмотра`
      : `Нет доступа к разделу «${title}» — обратитесь к администратору`;
  }

  return { wrap };
}

/**
 * Установить гейт на все последующие ipcMain.handle-регистрации. Вызывать ПЕРЕД
 * register*-функциями; вернувшийся restore() — после них (чтобы не трогать чужие
 * поздние регистрации, если появятся).
 */
export function installSectionIpcGate(ctx: IpcContext): () => void {
  const gate = createSectionIpcGate(ctx);
  const original = ipcMain.handle.bind(ipcMain);
  (ipcMain as any).handle = (channel: string, handler: (...a: any[]) => any) =>
    original(channel, gate.wrap(channel, handler) as any);
  return () => {
    (ipcMain as any).handle = original;
  };
}
