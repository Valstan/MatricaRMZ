import { describe, expect, it } from 'vitest';

import { recompressedDiskPath } from './recompressStoredPhotos.js';

/**
 * Проход переписывает живые снимки, и его безопасность держится на одном свойстве: новая копия
 * ложится по ДРУГОМУ пути, а старая удаляется только после того, как строка уже указывает на
 * новую. Совпади пути — оригинал затирался бы до всякой проверки, и обрыв связи посреди прохода
 * оставил бы строку, указывающую в никуда.
 */
describe('recompressedDiskPath', () => {
  const id = 'bfc2a3c8-1bbb-4355-aaf1-4da7af467e32';

  it('кладёт копию в свою папку, а не поверх оригинала', () => {
    const p = recompressedDiskPath('/MatricaRMZ/files', id, 'IMG_6765.JPG');
    expect(p).toBe('/MatricaRMZ/files/recompressed/bf/bfc2a3c8-1bbb-4355-aaf1-4da7af467e32_IMG_6765.JPG');
    expect(p).not.toBe(`/MatricaRMZ/files/${id}_IMG_6765.JPG`);
  });

  it('разводит файлы по подпапкам, как и остальное хранилище', () => {
    // Плоская папка на тысячи файлов у Я.Диска листается медленно, поэтому две буквы id.
    expect(recompressedDiskPath('/base', '0a111111-2222-3333-4444-555555555555', 'a.jpg')).toContain('/recompressed/0a/');
  });

  it('переживает базовый путь со слэшем на конце и корневой', () => {
    expect(recompressedDiskPath('/base/', id, 'a.jpg')).toBe(`/base/recompressed/bf/${id}_a.jpg`);
    expect(recompressedDiskPath('/', id, 'a.jpg')).toBe(`/recompressed/bf/${id}_a.jpg`);
  });
});
