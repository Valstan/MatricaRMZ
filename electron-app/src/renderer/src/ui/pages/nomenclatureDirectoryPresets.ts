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
    itemType: 'product',
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
    itemType: 'tool_consumable',
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
    itemType: 'product',
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
    itemType: 'product',
    category: 'service',
  },
};

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
