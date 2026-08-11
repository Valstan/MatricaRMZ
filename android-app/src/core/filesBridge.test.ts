// Вложения на планшете: свой узкий мост поверх REST (десктопный register/files.ts
// построен вокруг путей на диске и на WebView неприменим). Проверяем, что каналы
// зарегистрированы и говорят с сервером тем же контрактом, что и десктоп.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { API, startBridgeHarness, PERMS, type BridgeHarness } from './testing/bridgeHarness.js';

describe('android files bridge', () => {
  let h: BridgeHarness;
  const seen: { url: string; body: unknown }[] = [];

  beforeEach(async () => {
    seen.length = 0;
    PERMS['files.view'] = true;
    PERMS['files.upload'] = true;
    PERMS['files.delete'] = true;
    h = await startBridgeHarness({
      routes: (url, init) => {
        if (url.startsWith(`${API}/files/upload`)) {
          seen.push({ url, body: JSON.parse(String(init?.body ?? '{}')) });
          return Response.json({ ok: true, file: { id: 'f-1', name: 'Фото.jpg', size: 3, mime: 'image/jpeg' } });
        }
        if (url.endsWith('/preview')) {
          return Response.json({ ok: true, preview: { mime: 'image/png', dataBase64: 'AAAB' } });
        }
        return null;
      },
    });
  });

  afterEach(async () => {
    delete PERMS['files.view'];
    delete PERMS['files.upload'];
    delete PERMS['files.delete'];
    await h.dispose();
  });

  it('uploadBlob уносит содержимое на /files/upload и возвращает ссылку на файл', async () => {
    const res = await h.matrica().files.uploadBlob({
      name: 'Фото 11.08.2026 12-00-00.jpg',
      mime: 'image/jpeg',
      dataBase64: 'AQID',
      scope: { ownerType: 'engine', ownerId: 'e-1', category: 'photo' },
    });

    expect(res.ok).toBe(true);
    expect(res.ok && res.file.id).toBe('f-1');
    expect(seen).toHaveLength(1);
    expect(seen[0]?.body).toMatchObject({
      name: 'Фото 11.08.2026 12-00-00.jpg',
      mime: 'image/jpeg',
      dataBase64: 'AQID',
      scope: { ownerType: 'engine', ownerId: 'e-1', category: 'photo' },
    });
  });

  it('uploadBlob не отправляет пустой файл', async () => {
    const res = await h.matrica().files.uploadBlob({ name: 'пусто.txt', dataBase64: '' });
    expect(res.ok).toBe(false);
    expect(seen).toHaveLength(0);
  });

  it('previewGet собирает data:URL из base64 сервера', async () => {
    const res = await h.matrica().files.previewGet({ fileId: 'f-1' });
    expect(res.ok).toBe(true);
    expect(res.ok && res.dataUrl).toBe('data:image/png;base64,AAAB');
  });

  it('десктопные каналы (выбор файла, папки, печать) на планшете по-прежнему недоступны', async () => {
    const pick = await h.matrica().files.pick();
    expect(pick.ok).toBe(false);
    expect(pick.ok ? '' : pick.error).toContain('недоступно на планшете');
  });
});
