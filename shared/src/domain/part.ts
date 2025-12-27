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

