// Самообновление планшетного клиента «как на Винде»: при запуске спрашиваем
// Диспетчер (/dispatcher/checkin, platform=android), и если сервер видит версию
// свежее — предлагаем поставить сразу. Скачивание и передача системному
// установщику — в нативном ApkUpdaterPlugin (WebView не может ставить APK, а
// тащить 25 МБ через bridge — байтовый кап, GOTCHAS M74).
//
// Сетевые ошибки здесь молча глотаются: чек-ин — фоновая любезность, а не
// условие работы (сервер может быть недоступен, клиент обязан работать локально).
import { registerPlugin } from '@capacitor/core';

type ApkUpdaterPlugin = {
  downloadAndInstall(opts: { url: string; sha256?: string; fileName?: string; size?: number }): Promise<{ started: boolean }>;
};

type CheckinLatest = {
  version: string;
  fileName: string;
  size: number;
  sha256: string;
  url: string;
};

export async function checkAndOfferSelfUpdate(opts: {
  apiBaseUrl: string;
  currentVersion: string;
  clientId: string;
  log: (msg: string) => void;
}): Promise<void> {
  const { apiBaseUrl, currentVersion, clientId, log } = opts;
  let latest: CheckinLatest | null = null;
  try {
    const resp = await fetch(`${apiBaseUrl.replace(/\/+$/, '')}/dispatcher/checkin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: currentVersion, hostname: `android-${clientId.slice(0, 8)}`, platform: 'android' }),
    });
    const data = (await resp.json()) as { ok?: boolean; action?: string; latest?: CheckinLatest };
    if (!data.ok || data.action !== 'update' || !data.latest?.url) {
      log(`self-update: action=${data.action ?? 'none'} (current=${currentVersion})`);
      return;
    }
    latest = data.latest;
  } catch (e) {
    log(`self-update: checkin failed (${String(e)})`);
    return;
  }

  log(`self-update: доступна версия ${latest.version} (${latest.fileName}, ${latest.size} bytes)`);
  // Нативный confirm WebView: простое «да/нет» без вмешательства в renderer.
  const agreed = globalThis.confirm?.(
    `Доступно обновление программы: версия ${latest.version}.\n` + `Установить сейчас? Данные сохранятся.`,
  );
  if (!agreed) {
    log('self-update: пользователь отложил установку');
    return;
  }
  try {
    const updater = registerPlugin<ApkUpdaterPlugin>('ApkUpdater');
    await updater.downloadAndInstall({
      url: latest.url,
      sha256: latest.sha256,
      fileName: latest.fileName,
      size: latest.size,
    });
    log('self-update: установщик запущен');
  } catch (e) {
    log(`self-update: установка не удалась (${String(e)})`);
  }
}
