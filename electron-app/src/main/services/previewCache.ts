/**
 * Кэш превью файлов в главном процессе (владелец 12.09.2026: «кэширование превью картинок в списках»).
 *
 * До него каждый список при каждом монтировании тянул `GET /files/:id/preview` заново — по пять
 * запросов на строку, при переключении вкладок повторно. Кэш живёт в main, поэтому общий для всех
 * окон и всех списков; ключ — id файла, превью у файла одно и меняется только его повторной
 * загрузкой (`uploadPreview`) или удалением файла — обе точки инвалидируют запись.
 *
 * Отрицательный результат (`null` — превью нет) тоже кэшируется: иначе строки без превью дёргали бы
 * сервер вечно. Ограничения — по числу записей и по сумме байт, вытеснение самых старых по обращению.
 */
export type PreviewCacheEntry = { dataUrl: string | null };

export const PREVIEW_CACHE_MAX_ENTRIES = 600;
export const PREVIEW_CACHE_MAX_BYTES = 64 * 1024 * 1024;

export class PreviewCache {
  private readonly map = new Map<string, PreviewCacheEntry>();
  private bytes = 0;

  constructor(
    private readonly maxEntries = PREVIEW_CACHE_MAX_ENTRIES,
    private readonly maxBytes = PREVIEW_CACHE_MAX_BYTES,
  ) {}

  get(fileId: string): PreviewCacheEntry | undefined {
    const hit = this.map.get(fileId);
    if (!hit) return undefined;
    // Map хранит порядок вставки — перевставка делает запись самой свежей.
    this.map.delete(fileId);
    this.map.set(fileId, hit);
    return hit;
  }

  set(fileId: string, dataUrl: string | null): void {
    const size = dataUrl ? dataUrl.length : 0;
    if (size > this.maxBytes) return;
    this.delete(fileId);
    this.map.set(fileId, { dataUrl });
    this.bytes += size;
    while (this.map.size > this.maxEntries || this.bytes > this.maxBytes) {
      const oldest = this.map.keys().next();
      if (oldest.done) break;
      this.delete(oldest.value);
    }
  }

  delete(fileId: string): void {
    const prev = this.map.get(fileId);
    if (!prev) return;
    this.map.delete(fileId);
    this.bytes -= prev.dataUrl ? prev.dataUrl.length : 0;
  }

  clear(): void {
    this.map.clear();
    this.bytes = 0;
  }

  get size(): number {
    return this.map.size;
  }

  get totalBytes(): number {
    return this.bytes;
  }
}

export const previewCache = new PreviewCache();
