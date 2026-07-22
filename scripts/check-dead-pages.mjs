#!/usr/bin/env node
// Ищет страницы renderer'а, которые физически лежат в pages/, но не смонтированы.
//
// Зачем отдельный скрипт, а не knip: страницы грузятся через `import.meta.glob('./pages/*.tsx')`
// + реестр литеральных ключей `lazyPage(...)` в App.tsx. knip динамический glob не резолвит,
// поэтому pages/*.tsx объявлены в knip.json entry-точками — и мёртвая страница для него
// всегда «используется». Именно так 1121 строка мёртвого кода пережила два месячных прогона
// (аудит бэклога 2026-07-22). Здесь проверка прямая: есть файл — есть ли на него ссылка.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const UI_DIR = 'electron-app/src/renderer/src/ui';
const PAGES_DIR = join(UI_DIR, 'pages');

const pages = readdirSync(PAGES_DIR).filter((f) => f.endsWith('.tsx'));

// Всё, что может ссылаться на страницу: App.tsx (реестр lazyPage) и любой другой модуль ui/.
const sources = [];
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (/\.(ts|tsx)$/.test(entry.name)) sources.push(full);
  }
};
walk(UI_DIR);

const dead = [];
for (const page of pages) {
  const base = page.replace(/\.tsx$/, '');
  const referenced = sources.some((file) => {
    if (file.endsWith(join('pages', page))) return false; // сам себя не считаем
    const text = readFileSync(file, 'utf8');
    return text.includes(`pages/${base}`) || new RegExp(`(^|[^A-Za-z0-9_])${base}([^A-Za-z0-9_]|$)`, 'm').test(text);
  });
  if (!referenced) dead.push(page);
}

if (dead.length === 0) {
  console.log(`check-dead-pages: ok, ${pages.length} страниц, все смонтированы`);
  process.exit(0);
}

console.error(`check-dead-pages: найдены несмонтированные страницы (${dead.length} из ${pages.length}):`);
for (const page of dead) console.error(`  ${join(PAGES_DIR, page)}`);
console.error('\nЛибо смонтировать в App.tsx, либо удалить (вместе со строкой в electron.vite.config.ts manualChunks).');
process.exit(1);
