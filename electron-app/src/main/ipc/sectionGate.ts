/**
 * Ф2 «доступа по разделам» (plan docs/plans/section-access-2026-07.md): энфорс
 * НА ПРИЛОЖЕНИИ (решение владельца 2026-07-02 — сохраняем модель «полная база на
 * каждом клиенте», как у нарядов Рамзии; sync не фильтруем). Main-процесс
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
import { getSectionMembershipByLogin } from '../services/employeeService.js';
import { entities, entityTypes } from '../database/schema.js';

// Longest-prefix wins (порядок не важен — выбираем самое длинное совпадение).
const PREFIX_RULES: ReadonlyArray<readonly [string, AccessSection]> = [
  ['engine:', 'production'],
  ['ops:', 'production'],
  ['parts:', 'production'],
  ['checklists:', 'production'],
  ['warehouse:assemblyBom:', 'production'],
  ['warehouse:engineInstances:', 'production'],
  ['workOrders:', 'work_orders'],
  ['workOrderTemplates:', 'work_orders'],
  ['signatureCaptions:', 'work_orders'],
  ['supplyRequests:', 'supply'],
  ['warehouse:contracts:', 'contracts'],
  ['warehouse:', 'warehouse'],
  ['warehouseLocations:', 'warehouse'],
  ['erp:', 'warehouse'],
  // employees:list/get/defs/departments — сквозные lookup'ы (наряды, чат, табель,
  // инструмент) — НЕ гейтим; закрываем только управление карточками/правами.
  ['employees:setAttr', 'people'],
  ['employees:create', 'people'],
  ['employees:delete', 'people'],
  ['employees:merge', 'people'],
  ['employees:permissionsGet', 'people'],
  ['employees:resyncFromServer', 'people'],
  ['timesheets:', 'people'],
  ['reports:', 'reports'],
  ['reportsBuilder:', 'reports'],
  ['workshops:stats', 'reports'],
  // workshops:list — lookup цехов из чужих карточек; гейтим только управление.
  ['workshops:upsert', 'directories'],
  ['workshops:delete', 'directories'],
  ['maintenance:', 'directories'],
  ['audit:', 'administration'],
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
const ENTITY_TYPE_SECTION: Readonly<Record<string, AccessSection>> = {
  contract: 'contracts',
  counterparty: 'contracts',
  employee: 'people',
  engine: 'production',
  engine_brand: 'production',
  engine_brand_group: 'production',
};

// Мутирующие каналы гейтящихся разделов (Ф3): наблюдателю (viewer) — отказ,
// нужен editor. Только явный список — verb-эвристика ловила бы личные
// настройки (reports:favoritesSet) и read-каналы (warehouse:documents:plan).
const WRITE_CHANNELS = new Set([
  // production
  'engine:create',
  'engine:delete',
  'engine:setAttr',
  'engine:dedupe:merge',
  'ops:add',
  'parts:create',
  'parts:delete',
  'parts:updateAttribute',
  'parts:partBrandLinks:delete',
  'warehouse:assemblyBom:upsert',
  'warehouse:assemblyBom:delete',
  'warehouse:assemblyBom:archive',
  'warehouse:assemblyBom:activateDefault',
  'warehouse:assemblyBom:schema:set',
  'warehouse:engineInstances:upsert',
  'warehouse:engineInstances:delete',
  // work_orders
  'workOrders:create',
  'workOrders:update',
  'workOrders:delete',
  'workOrders:close',
  'workOrders:assemblyReturn',
  'workOrders:postAssembly',
  'workOrders:saveAssemblyDraft',
  'workOrders:deleteAssemblyDraft',
  'workOrderTemplates:delete',
  'signatureCaptions:add',
  // supply
  'supplyRequests:create',
  'supplyRequests:update',
  'supplyRequests:delete',
  'supplyRequests:transition',
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
  'warehouseLocations:delete',
  'warehouseLocations:registerUsage',
  'erp:documents:post',
  // people
  'employees:setAttr',
  'employees:create',
  'employees:delete',
  'employees:merge',
  'employees:resyncFromServer',
  'timesheets:create',
  'timesheets:update',
  'timesheets:delete',
  'timesheets:addRows',
  'timesheets:removeRow',
  'timesheets:setCells',
  // directories
  'workshops:upsert',
  'workshops:delete',
  'maintenance:emptyCards:delete',
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
  'admin:entities:detachLinksAndDelete',
]);
// Мутирующее подмножество generic admin:* каналов (Ф3 — требуют editor).
const ADMIN_WRITE_CHANNELS = new Set([
  'admin:entities:create',
  'admin:entities:setAttr',
  'admin:entities:softDelete',
  'admin:entities:detachLinksAndDelete',
]);

function matchPrefixRule(channel: string): AccessSection | null {
  let best: readonly [string, AccessSection] | null = null;
  for (const rule of PREFIX_RULES) {
    if (channel.startsWith(rule[0]) && (!best || rule[0].length > best[0].length)) best = rule;
  }
  return best ? best[1] : null;
}

export function createSectionIpcGate(ctx: IpcContext) {
  // Membership-кэш: гейт стоит на каждом IPC-вызове, скан EAV на каждый — дорого.
  let membershipCache: { login: string; value: SectionMembership | null; at: number } | null = null;
  const MEMBERSHIP_TTL_MS = 15_000;

  async function membershipFor(login: string): Promise<SectionMembership | null> {
    const now = Date.now();
    if (membershipCache && membershipCache.login === login && now - membershipCache.at < MEMBERSHIP_TTL_MS) {
      return membershipCache.value;
    }
    const value = await getSectionMembershipByLogin(ctx.dataDb(), login).catch(() => null);
    membershipCache = { login, value, at: now };
    return value;
  }

  async function isAllowed(sectionId: AccessSection, level: 'viewer' | 'editor'): Promise<boolean> {
    const viewer = await ctx.currentViewer();
    if (!viewer.login) return true; // не залогинен — auth-контроль на самих хэндлерах
    if (String(viewer.role ?? '').toLowerCase() === 'superadmin') return true;
    const membership = await membershipFor(viewer.login.toLowerCase());
    if (membership == null) return true; // не засеяно (legacy) — fail-open
    const check = level === 'editor' ? canEditSection : canViewSection;
    return check({ membership, role: viewer.role, sectionId });
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

  /** Обернуть handler канала section-гейтом (или вернуть как есть, если канал не гейтится). */
  function wrap(channel: string, handler: (...a: any[]) => any): (...a: any[]) => any {
    const prefixSection = matchPrefixRule(channel);
    const entityGated = TYPE_ARG_CHANNELS.has(channel) || ENTITY_ARG_CHANNELS.has(channel);
    if (!prefixSection && !entityGated) return handler;
    const level: 'viewer' | 'editor' =
      WRITE_CHANNELS.has(channel) || ADMIN_WRITE_CHANNELS.has(channel) ? 'editor' : 'viewer';
    return async (event: unknown, ...args: unknown[]) => {
      const sectionId = prefixSection ?? (await sectionForEntityArgs(channel, args));
      if (sectionId && !(await isAllowed(sectionId, level))) {
        const title = accessSectionMeta(sectionId)?.titleRu ?? sectionId;
        throw new Error(
          level === 'editor' && (await isAllowed(sectionId, 'viewer'))
            ? `Раздел «${title}» доступен вам только для просмотра`
            : `Нет доступа к разделу «${title}» — обратитесь к администратору`,
        );
      }
      return handler(event, ...args);
    };
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
