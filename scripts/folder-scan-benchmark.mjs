#!/usr/bin/env node
// ЗАМЕР: что именно занимает время при обходе папок (промт КАРМАНА #180).
//
// ЗАЧЕМ. Владелец описал картину: «на второй папке обход ползёт по одной
// папке». Нужно было назвать причину ЧИСЛАМИ, а не догадками. Инструмент
// меряет четыре вещи отдельно:
//
//   * «чтение папки»   — сколько времени ушло на чтение содержимого папок;
//   * «метаданные»     — сколько времени ушло на запросы размера и даты файлов;
//   * «ожидание сети»  — сколько запросов к сети было сделано (счётчик);
//   * «всего»          — сколько занял обход целиком.
//
// И меряет ДВА режима: «как было» (строго последовательно, метаданные каждого
// файла) и «как стало» (параллельный обход, без лишних метаданных). Разница
// между ними и есть ответ, что именно было тормозом.
//
// КАК ПОЛЬЗОВАТЬСЯ (на боевых папках оператора — с его машины):
//
//   node scripts/folder-scan-benchmark.mjs "D:\\Фото" "\\\\server\\share\\Фото"
//
// Папку с пробелами кавычить обязательно. Скрипт ничего не пишет на диск и
// только читает.
//
// ФЛАГИ:
//   --json            — вывести результат в JSON (для отчёта);
//   --repeat <n>      — сколько раз обойти каждую папку (по умолчанию 2:
//                       первый проход — «холодный», второй — «тёплый»);
//   --concurrency <n> — сколько папок читать одновременно в режиме «как стало»
//                       (по умолчанию 4, как в программе).

import { readdir, stat } from 'node:fs/promises';
import { basename, join, sep } from 'node:path';

const MAX_DEPTH = 3;
const MAX_FOLDERS = 5000;
const MAX_FILES = 20000;

function parseArgs(argv) {
  const folders = [];
  let json = false;
  let repeat = 2;
  let concurrency = 4;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') json = true;
    else if (arg === '--repeat') repeat = Number(argv[++i] ?? 2);
    else if (arg === '--concurrency') concurrency = Number(argv[++i] ?? 4);
    else folders.push(arg);
  }
  return { folders, json, repeat, concurrency };
}

function ms(value) {
  return `${Math.round(value)} мс`;
}

/**
 * Режим «КАК БЫЛО» (промт #180, до правки).
 *
 * Обход строго последовательный: прочитали папку — зашли в её содержимое —
 * потом в следующую. И на КАЖДЫЙ файл — отдельный запрос метаданных
 * (размер и дата) со своим потолком ожидания.
 */
async function walkLegacy(root) {
  const counters = {
    readdirCalls: 0,
    statCalls: 0,
    readdirMs: 0,
    statMs: 0,
    folders: 0,
    files: 0,
    unreadable: 0,
  };
  const started = Date.now();

  const walk = async (dirPath, level) => {
    if (level > MAX_DEPTH) return;
    let entries;
    const readStart = Date.now();
    try {
      entries = await readdir(dirPath, { withFileTypes: true });
    } catch {
      counters.unreadable += 1;
      return;
    }
    counters.readdirMs += Date.now() - readStart;
    counters.readdirCalls += 1;
    counters.folders += 1;
    for (const entry of entries) {
      const childPath = join(dirPath, entry.name);
      if (entry.isDirectory()) {
        if (counters.folders >= MAX_FOLDERS) continue;
        await walk(childPath, level + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      if (counters.files >= MAX_FILES) return;
      counters.files += 1;
      // Отдельный запрос метаданных на КАЖДЫЙ файл — как было.
      const statStart = Date.now();
      try {
        await stat(childPath);
      } catch {
        // Файл исчез — как и в программе, поиск идёт дальше.
      }
      counters.statMs += Date.now() - statStart;
      counters.statCalls += 1;
    }
  };

  await walk(root, 0);
  return { ...counters, totalMs: Date.now() - started };
}

/**
 * Режим «КАК СТАЛО» (промт #180, после правки).
 *
 * Обход с ограниченным параллелизмом и БЕЗ лишних запросов метаданных:
 * размер нужен только картинкам, попавшим в результат, а не каждому файлу.
 */
async function walkCurrent(root, concurrency) {
  const counters = {
    readdirCalls: 0,
    statCalls: 0,
    readdirMs: 0,
    statMs: 0,
    folders: 0,
    files: 0,
    unreadable: 0,
  };
  const started = Date.now();

  const queue = [{ dirPath: root, level: 0 }];
  let cursor = 0;
  let busy = 0;
  const waiters = [];

  const wake = () => {
    for (const resolve of waiters.splice(0)) resolve();
  };

  const processDir = async (task) => {
    let entries;
    const readStart = Date.now();
    try {
      entries = await readdir(task.dirPath, { withFileTypes: true });
    } catch {
      counters.unreadable += 1;
      return;
    }
    counters.readdirMs += Date.now() - readStart;
    counters.readdirCalls += 1;
    counters.folders += 1;
    for (const entry of entries) {
      const childPath = join(task.dirPath, entry.name);
      if (entry.isDirectory()) {
        if (counters.folders >= MAX_FOLDERS) continue;
        // Тот же потолок глубины, что в программе: папки глубже не обходятся.
        if (task.level + 1 > MAX_DEPTH) continue;
        queue.push({ dirPath: childPath, level: task.level + 1 });
        wake();
        continue;
      }
      if (!entry.isFile()) continue;
      if (counters.files >= MAX_FILES) return;
      counters.files += 1;
    }
  };

  const worker = async () => {
    for (;;) {
      if (cursor >= queue.length) {
        if (busy === 0) return;
        await new Promise((resolve) => waiters.push(resolve));
        continue;
      }
      const task = queue[cursor];
      cursor += 1;
      busy += 1;
      try {
        await processDir(task);
      } finally {
        busy -= 1;
        wake();
      }
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return { ...counters, totalMs: Date.now() - started };
}

function row(label, value) {
  return `${label.padEnd(34)} ${value}`;
}

async function main() {
  const { folders, json, repeat, concurrency } = parseArgs(process.argv.slice(2));
  if (folders.length === 0) {
    console.error('Укажите папку для замера:');
    console.error('  node scripts/folder-scan-benchmark.mjs "D:\\Фото"');
    process.exit(1);
  }

  const report = [];
  for (const folder of folders) {
    const perFolder = { folder, name: basename(folder) || folder, passes: [] };
    for (let pass = 0; pass < repeat; pass += 1) {
      const legacy = await walkLegacy(folder);
      const current = await walkCurrent(folder, concurrency);
      perFolder.passes.push({ pass: pass + 1, legacy, current });
    }
    report.push(perFolder);
  }

  if (json) {
    console.log(JSON.stringify({ measuredAt: new Date().toISOString(), concurrency, report }, null, 2));
    return;
  }

  console.log('ЗАМЕР ОБХОДА ПАПОК (промт КАРМАНА #180)');
  console.log(`Параллелизм режима «как стало»: ${concurrency}\n`);
  for (const perFolder of report) {
    console.log(`Папка: ${perFolder.folder}`);
    for (const pass of perFolder.passes) {
      const kind = perFolder.passes.length > 1 ? `проход ${pass.pass}` : 'проход';
      console.log(`  ${kind}`);
      console.log(
        row(
          '    «как было» (по одной папке + stat)',
          `всего ${ms(pass.legacy.totalMs)} · чтение папок ${ms(pass.legacy.readdirMs)} · метаданные ${ms(pass.legacy.statMs)} · запросов: папок ${pass.legacy.readdirCalls}, файлов ${pass.legacy.statCalls}`,
        ),
      );
      console.log(
        row(
          '    «как стало» (параллельно, без stat)',
          `всего ${ms(pass.current.totalMs)} · чтение папок ${ms(pass.current.readdirMs)} · метаданные ${ms(pass.current.statMs)} · запросов: папок ${pass.current.readdirCalls}, файлов ${pass.current.statCalls}`,
        ),
      );
      const speed = pass.legacy.totalMs > 0 ? pass.legacy.totalMs / Math.max(1, pass.current.totalMs) : 0;
      console.log(
        row(
          '    выигрыш',
          speed > 1.05
            ? `×${speed.toFixed(2)} (${ms(pass.legacy.totalMs - pass.current.totalMs)} быстрее)`
            : `×${speed.toFixed(2)} — на этой папке разницы нет (быстрый локальный диск)`,
        ),
      );
      console.log('');
    }
  }
}

main().catch((e) => {
  console.error(String(e));
  process.exit(1);
});
