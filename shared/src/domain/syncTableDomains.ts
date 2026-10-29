/**
 * Какие экраны задевает изменение таблицы контракта.
 *
 * Синк приносит правки пачками по десяткам таблиц — и раньше каждый прогон означал
 * «перечитай свой список» для всех открытых вкладок, включая спящие. Здесь лежит ответ
 * на вопрос «а моих ли это дел», чтобы дёргать только затронутые экраны.
 *
 * Правила, на которых держится карта (см. сторож `syncTableDomains.test.ts`):
 *   • у каждой таблицы контракта есть хотя бы один домен — иначе её правки молча никого
 *     не разбудят, и экран покажет вчерашнее;
 *   • у каждого домена есть хотя бы одна таблица — иначе страница, объявившая только
 *     такой домен, не проснётся никогда;
 *   • незнакомая таблица трактуется как «задевает всё» — ошибка в сторону лишнего
 *     перечитывания, а не устаревшего экрана.
 */

export type SyncDomain =
  /** Двигатели: карточки, номера РМЗ, сборочные спецификации, ремфонд. */
  | 'engines'
  /** Наряды. */
  | 'workOrders'
  /** Строки табеля работ — они же записи истории ремонта. */
  | 'workSheets'
  /** Склад: номенклатура, остатки, движения, места хранения. */
  | 'warehouse'
  /** Снабжение: заявки, инструмент, продукция, услуги. */
  | 'supply'
  /** Договоры и контрагенты. */
  | 'contracts'
  /** Сотрудники, подписи по умолчанию. */
  | 'employees'
  /** СИЗ. */
  | 'ppe'
  /** Чат, присутствие, ИИ-запросы. */
  | 'chat'
  /** Заметки. */
  | 'notes'
  /** Аккаунты и доступы к разделам. */
  | 'users'
  /** Черновики карточек. */
  | 'drafts'
  /** Журнал действий. */
  | 'audit'
  /**
   * EAV-ядро: типы, сущности, атрибуты. Читает почти каждый экран — двигатели, детали,
   * инструмент, услуги, марки, сотрудники, заявки. Поэтому страницы, которые показывают
   * атрибуты сущностей, объявляют этот домен вместе со своим.
   */
  | 'directories';

export const TABLE_DOMAINS: Readonly<Record<string, readonly SyncDomain[]>> = {
  entity_types: ['directories'],
  entities: ['directories'],
  attribute_defs: ['directories'],
  attribute_values: ['directories'],

  // Строки нарядов и строки табеля — одни и те же записи истории ремонта.
  operations: ['workOrders', 'workSheets'],
  audit_log: ['audit'],

  chat_messages: ['chat'],
  chat_reads: ['chat'],
  chat_rooms: ['chat'],
  user_presence: ['chat'],
  ai_chat_requests: ['chat'],

  notes: ['notes'],
  note_shares: ['notes'],
  card_drafts: ['drafts'],

  erp_nomenclature: ['warehouse', 'supply'],
  erp_engine_assembly_bom: ['engines'],
  erp_engine_assembly_bom_lines: ['engines'],
  erp_engine_assembly_bom_brand_links: ['engines'],
  erp_engine_instances: ['engines'],
  erp_reg_stock_balance: ['warehouse'],
  erp_reg_stock_movements: ['warehouse'],
  erp_engine_inventory_lines: ['engines', 'warehouse'],
  warehouse_locations: ['warehouse'],

  erp_counterparties: ['contracts', 'supply'],
  erp_contracts: ['contracts'],
  erp_contract_payment_slots: ['contracts'],
  erp_contract_payments: ['contracts'],

  directory_engine_brands: ['directories', 'engines'],
  users: ['users'],
  user_section_access: ['users'],

  erp_engine_cards: ['engines'],
  erp_engine_numbers: ['engines'],

  ppe_norm_sets: ['ppe'],
  ppe_norm_lines: ['ppe'],
  ppe_issue_cards: ['ppe'],
  ppe_card_norms: ['ppe'],
  ppe_issue_entries: ['ppe'],
  ppe_absences: ['ppe'],
  ppe_groups: ['ppe'],
  ppe_group_members: ['ppe'],
  ppe_group_norms: ['ppe'],
  ppe_collectives: ['ppe'],
  ppe_collective_lines: ['ppe'],

  erp_employee_cards: ['employees'],
  signature_defaults: ['employees'],
};

/** Домены, которых касаются правки этих таблиц. */
export function domainsOfTables(tables: Iterable<string>): Set<SyncDomain> {
  const out = new Set<SyncDomain>();
  for (const table of tables) {
    for (const domain of TABLE_DOMAINS[String(table ?? '').trim()] ?? []) out.add(domain);
  }
  return out;
}

/**
 * Задевает ли этот набор таблиц хоть один из доменов страницы.
 *
 * Незнакомая таблица (карта не знает её — новый контракт, старый клиент) отвечает «да»:
 * экран перечитается лишний раз, но не покажет устаревшее.
 */
export function tablesTouchDomains(
  tables: readonly string[],
  domains: readonly SyncDomain[],
): boolean {
  if (domains.length === 0) return true;
  const wanted = new Set<SyncDomain>(domains);
  for (const table of tables) {
    const mapped = TABLE_DOMAINS[String(table ?? '').trim()];
    if (!mapped) return true;
    for (const domain of mapped) if (wanted.has(domain)) return true;
  }
  return false;
}
