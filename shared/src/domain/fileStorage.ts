// Унифицированная ссылка на файл, которую мы храним в EAV (attribute_values) и/или operations.metaJson.
// Сами байты файла лежат в файловом хранилище (локально на сервере или в Яндекс.Диске).

export type FileRef = {
  id: string; // UUID на сервере (file_assets.id)
  name: string; // исходное имя файла
  size: number; // bytes
  mime: string | null; // MIME type (если известен)
  sha256: string; // хэш содержимого (для диагностики/кеша)
  createdAt: number; // ms epoch
  // UI-метка в карточках сущностей: файл помечен как устаревшая версия.
  isObsolete?: boolean;
};


