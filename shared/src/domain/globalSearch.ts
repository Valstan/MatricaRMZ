// Unified global-search result shape, shared by the backend /search endpoint,
// the IPC bridge and the renderer command palette (Ctrl+K). The `kind` values are a
// subset of the renderer's DeepLinkRoute kinds, so a hit doubles as a navigation target.

export type GlobalSearchKind =
  | 'engine'
  | 'engine_brand'
  | 'nomenclature'
  | 'contract'
  | 'request'
  | 'employee'
  | 'counterparty'
  | 'service'
  | 'product'
  | 'tool'
  | 'tool_property'
  | 'work_order'
  | 'stock_document';

export const GLOBAL_SEARCH_KINDS: readonly GlobalSearchKind[] = [
  'engine',
  'engine_brand',
  'nomenclature',
  'contract',
  'request',
  'employee',
  'counterparty',
  'service',
  'product',
  'tool',
  'tool_property',
  'work_order',
  'stock_document',
];

export type GlobalSearchHit = {
  kind: GlobalSearchKind;
  id: string;
  label: string;
  sublabel?: string;
  code?: string;
};

export type GlobalSearchResponse = {
  query: string;
  hits: GlobalSearchHit[];
  truncated: boolean;
};

const KIND_LABELS: Record<GlobalSearchKind, string> = {
  engine: 'Двигатели',
  engine_brand: 'Марки двигателей',
  nomenclature: 'Детали / номенклатура',
  contract: 'Контракты',
  request: 'Заявки в снабжение',
  employee: 'Сотрудники',
  counterparty: 'Контрагенты',
  service: 'Услуги',
  product: 'Изделия',
  tool: 'Инструменты',
  tool_property: 'Свойства инструмента',
  work_order: 'Наряды',
  stock_document: 'Складские документы',
};

export function globalSearchKindLabel(kind: GlobalSearchKind): string {
  return KIND_LABELS[kind] ?? kind;
}
