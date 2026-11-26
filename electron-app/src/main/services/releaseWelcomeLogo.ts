import { app } from 'electron';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, extname, join } from 'node:path';

/**
 * Логотип завода для окна приветствия (промт КАРМАНА #162).
 *
 * Файла от владельца пока нет — окно рисует заглушку и не падает. Когда файл появится,
 * его достаточно положить рядом с программой: `welcome-logo.png` (или `.svg`) в папке
 * пользователя или в ресурсах сборки — код анимации не меняется.
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
    // Пути пользователя недоступны — ищем дальше.
  }
  if (process.resourcesPath) files.push(join(process.resourcesPath, 'welcome-logo.png'));
  files.push(join(app.getAppPath(), 'resources', 'welcome-logo.png'));
  return files;
}

export function readReleaseWelcomeLogo(): { dataUrl: string; fileName: string } | null {
  for (const file of candidateFiles()) {
    try {
      if (!existsSync(file)) continue;
      if (statSync(file).size > MAX_LOGO_BYTES) continue;
      const mime = MIME_BY_EXT[extname(file).toLowerCase()] ?? 'image/png';
      const data = readFileSync(file).toString('base64');
      return { dataUrl: `data:${mime};base64,${data}`, fileName: basename(file) };
    } catch {
      continue;
    }
  }
  return null;
}
