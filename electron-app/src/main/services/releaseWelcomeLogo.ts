import { app } from 'electron';
import { existsSync, promises as fsp } from 'node:fs';
import { basename, extname, join } from 'node:path';

/**
 * Логотип завода для окна приветствия (промт КАРМАНА #162).
 *
 * Файла от владельца пока нет — окно рисует заглушку и не падает. Когда файл появится,
 * его достаточно положить рядом с программой: `welcome-logo.png` (или `.svg`) в папке
 * пользователя или в ресурсах сборки — код анимации не меняется.
 *
 * Файл читается через `promises` из `node:fs`: планшетный порт тянет этот модуль в
 * свой бандл (он регистрирует настоящий `ipc/register/settings`), а шим планшета
 * отдаёт только асинхронную поверхность `node:fs` — синхронной там нет.
 */

const MAX_LOGO_BYTES = 2 * 1024 * 1024;

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

function candidateFiles(): string[] {
  const files: string[] = [];
  try {
    files.push(join(app.getPath('userData'), 'welcome-logo.png'));
    files.push(join(app.getPath('userData'), 'welcome-logo.svg'));
  } catch {
    // Папка пользователя недоступна — ищем дальше.
  }
  try {
    if (process.resourcesPath) files.push(join(process.resourcesPath, 'welcome-logo.png'));
  } catch {
    // Ресурсов сборки нет (планшетный порт).
  }
  try {
    files.push(join(app.getAppPath(), 'resources', 'welcome-logo.png'));
  } catch {
    // Путь приложения недоступен (планшетный порт).
  }
  return files;
}

export async function readReleaseWelcomeLogo(): Promise<{ dataUrl: string; fileName: string } | null> {
  for (const file of candidateFiles()) {
    try {
      if (!existsSync(file)) continue;
      const data = await fsp.readFile(file);
      if (data.length > MAX_LOGO_BYTES) continue;
      const mime = MIME_BY_EXT[extname(file).toLowerCase()] ?? 'image/png';
      return {
        dataUrl: `data:${mime};base64,${Buffer.from(data).toString('base64')}`,
        fileName: basename(file),
      };
    } catch {
      continue;
    }
  }
  return null;
}
