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

// Phase 2 (parts→nomenclature, Variant A): part-spec stored on the extended
// directory_parts row. brandLinks omit partId — the spec belongs to one part
// (its nomenclature id), so the parent id is implicit.
// Т4 (parts-articul-acts program): per-brand act flags. A part flagged here is
// printed into the corresponding act of engines of this brand; engine inventory
// rows copy the flags at row creation (per-engine override = editing the copy).
export type PartSpecBrandLink = {
  id: string;
  engineBrandId: string | null;
  assemblyUnitNumber: string | null;
  quantity: number;
  inCompletenessAct?: boolean;
  inDefectAct?: boolean;
  // Живая привязка к группе марок: маркер источника связи.
  //  - absent  → manual (владеет оператор, авто-логика не трогает);
  //  - present + engineBrandId → derived (марка применима, т.к. группа sourceGroupId её содержит);
  //  - present + engineBrandId=null → anchor («деталь следит за группой», когда группа не даёт derived).
  // Пересобирается recomputePartBrandLinks; см. shared/src/domain/liveGroupLinks.ts.
  sourceGroupId?: string;
};

export type PartSpec = {
  code: string | null;
  dimensions: PartDimension[];
  brandLinks: PartSpecBrandLink[];
};

// Phase 3 (parts EAV → directory_parts): the residual part fields that used to
// live in the legacy `parts` EAV store, carried in directory_parts.metadataJson.
// All keys optional — written via conditional spread (exactOptionalPropertyTypes).
// Scalars mirror their legacy EAV storage (purchaseDate / status dates are ms).
export type PartCustomFieldDef = {
  code: string;
  name: string;
  dataType: string;
  sortOrder?: number;
};

export type PartMetadata = {
  description?: string;
  assemblyUnitNumber?: string;
  engineNodeId?: string;
  purchaseDate?: number;
  supplierId?: string;
  supplierLegacy?: string;
  contractId?: string;
  drawings?: FileRef[];
  techDocs?: FileRef[];
  attachments?: FileRef[];
  statusFlags?: Record<string, boolean>;
  statusDates?: Record<string, number>;
  custom?: Record<string, unknown>;
  customDefs?: PartCustomFieldDef[];
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

