import type { NomenclatureItemType } from '@matricarmz/shared';

export type NomenclatureCreateConfig = {
  codePrefix: string;
  name: string;
  itemType: NomenclatureItemType;
  category: string;
};

export type NomenclatureDirectoryPreset = {
  directoryKind: string;
  emptyText: string;
  searchPlaceholder: string;
  createButtonText: string;
  createConfig: NomenclatureCreateConfig;
};

export const PARTS_PRESET: NomenclatureDirectoryPreset = {
  directoryKind: 'part',
  emptyText: 'Нет деталей',
  searchPlaceholder: 'Поиск деталей...',
  createButtonText: 'Добавить деталь',
  createConfig: {
    codePrefix: 'DET',
    name: 'Новая деталь',
    itemType: 'part',
    category: 'component',
  },
};

export const TOOLS_PRESET: NomenclatureDirectoryPreset = {
  directoryKind: 'tool',
  emptyText: 'Нет инструментов',
  searchPlaceholder: 'Поиск инструментов...',
  createButtonText: 'Создать инструмент',
  createConfig: {
    codePrefix: 'TLS',
    name: 'Новый инструмент',
    itemType: 'tool',
    category: 'component',
  },
};

export const PRODUCTS_PRESET: NomenclatureDirectoryPreset = {
  directoryKind: 'good',
  emptyText: 'Нет товаров',
  searchPlaceholder: 'Поиск товаров...',
  createButtonText: 'Добавить товар',
  createConfig: {
    codePrefix: 'PRD',
    name: 'Новый товар',
    itemType: 'good',
    category: 'assembly',
  },
};

export const SERVICES_PRESET: NomenclatureDirectoryPreset = {
  directoryKind: 'service',
  emptyText: 'Нет услуг',
  searchPlaceholder: 'Поиск услуг...',
  createButtonText: 'Добавить услугу',
  createConfig: {
    codePrefix: 'SRV',
    name: 'Новая услуга',
    itemType: 'service',
    category: 'service',
  },
};

export const ASSEMBLY_PRESET: NomenclatureDirectoryPreset = {
  directoryKind: 'assembly',
  emptyText: 'Нет сборочных единиц',
  searchPlaceholder: 'Поиск сборочных единиц...',
  createButtonText: 'Добавить узел',
  createConfig: {
    codePrefix: 'ASM',
    name: 'Новая сборочная единица',
    itemType: 'assembly',
    category: 'assembly',
  },
};

export const ENGINE_PRESET: NomenclatureDirectoryPreset = {
  directoryKind: 'engine',
  emptyText: 'Нет двигателей',
  searchPlaceholder: 'Поиск двигателей...',
  createButtonText: 'Добавить двигатель',
  createConfig: {
    codePrefix: 'ENG',
    name: 'Новый двигатель',
    itemType: 'engine',
    category: 'engine',
  },
};

export const COMPONENT_PRESET: NomenclatureDirectoryPreset = {
  directoryKind: 'component',
  emptyText: 'Нет комплектующих',
  searchPlaceholder: 'Поиск комплектующих...',
  createButtonText: 'Добавить комплектующее',
  createConfig: {
    codePrefix: 'CMP',
    name: 'Новое комплектующее',
    itemType: 'component',
    category: 'component',
  },
};

export const MATERIAL_PRESET: NomenclatureDirectoryPreset = {
  directoryKind: 'material',
  emptyText: 'Нет материалов',
  searchPlaceholder: 'Поиск материалов...',
  createButtonText: 'Добавить материал',
  createConfig: {
    codePrefix: 'MAT',
    name: 'Новый материал',
    itemType: 'material',
    category: 'component',
  },
};

export const CONSUMABLE_PRESET: NomenclatureDirectoryPreset = {
  directoryKind: 'consumable',
  emptyText: 'Нет расходников',
  searchPlaceholder: 'Поиск расходников...',
  createButtonText: 'Добавить расходник',
  createConfig: {
    codePrefix: 'CNS',
    name: 'Новый расходник',
    itemType: 'consumable',
    category: 'component',
  },
};

/** Все пресеты для единого диалога создания. */
export const ALL_NOMENCLATURE_CREATE_PRESETS: ReadonlyArray<NomenclatureDirectoryPreset> = [
  PARTS_PRESET,
  ASSEMBLY_PRESET,
  ENGINE_PRESET,
  COMPONENT_PRESET,
  MATERIAL_PRESET,
  CONSUMABLE_PRESET,
  TOOLS_PRESET,
  PRODUCTS_PRESET,
  SERVICES_PRESET,
];

/** Виды номенклатуры, доступные при создании позиции из заявки в снабжение. */
export const SUPPLY_REQUEST_LINE_CREATE_PRESETS = [PARTS_PRESET, TOOLS_PRESET, PRODUCTS_PRESET, SERVICES_PRESET] as const;

export function labelForSupplyRequestCreateKind(directoryKind: string): string {
  const k = String(directoryKind ?? '').trim().toLowerCase();
  const map: Record<string, string> = {
    part: 'Деталь',
    tool: 'Инструмент',
    good: 'Товар',
    service: 'Услуга',
    engine_brand: 'Марка двигателя',
  };
  return map[k] ?? directoryKind;
}
