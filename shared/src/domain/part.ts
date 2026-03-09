// Типы для модуля учета изготовления деталей

import type { FileRef } from './fileStorage.js';

// Карта детали - основная структура
export type PartCard = {
  id: string; // entity.id
  createdAt: number; // ms timestamp
  updatedAt: number; // ms timestamp
};

// Атрибут детали
export type PartAttribute = {
  id: string; // attribute_def.id
  code: string; // код атрибута (например, 'name', 'article', 'manufacturer')
  name: string; // название атрибута
  dataType: 'text' | 'number' | 'boolean' | 'date' | 'json' | 'link';
  value: unknown; // значение атрибута (парсится из value_json)
  isRequired: boolean;
  sortOrder: number;
  metaJson?: unknown; // дополнительные параметры поля
};

// Ссылка на файл в карте детали
export type PartFileRef = FileRef & {
  description?: string; // описание файла (чертеж, технологическая карта и т.д.)
  category?: string; // категория файла
};

// Связь детали с двигателем
export type PartEngineLink = {
  engineId: string;
  engineNumber?: string;
  relationType?: string; // тип связи (используется в, изготовлена для и т.д.)
  note?: string;
};

export type PartEngineBrandLink = {
  id: string;
  partId: string;
  engineBrandId: string;
  assemblyUnitNumber: string;
  quantity: number;
};

export const PART_TEMPLATE_ID_ATTR_CODE = 'part_template_id';
export const PART_DIMENSIONS_ATTR_CODE = 'dimensions';

export type PartDimension = {
  id: string;
  name: string;
  value: string;
};

export type PartTemplateCard = {
  id: string;
  createdAt: number;
  updatedAt: number;
};

export type PartUsageRef = {
  kind: 'contract' | 'engine_brand' | 'work_order' | 'service' | 'link';
  entityId: string;
  label: string;
  description?: string | null;
  targetTypeCode?: string | null;
};

