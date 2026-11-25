// Сторож поверхности каналов: каждый канал preload, который зовёт renderer и
// который планшет обязан поддерживать, зарегистрирован в мосте Android.
//
// Ловится класс дефекта, который до сих пор ловили только глазами: домен есть
// в коде, раздел есть в меню планшета, а канал в мосте не зарегистрирован —
// renderer получает мягкий отказ «недоступно на планшете: <канал>» и молча
// ничего не делает. Именно так была потеряна запись карточки двигателя
// (`engines:card:save`): домен `engineCards` не был зарегистрирован в
// `ipcWiring.ts`, и правка карточки на планшете не сохранялась (промт
// КАРМАНА #111, план #113, этап A п.3).
//
// Проверка поверхностная намеренно: она отвечает на вопрос «канал из preload
// есть в мосте?», а не «работает ли он» — это уже смоук (bridge.smoke.test.ts).
//
// ПРАВИЛО. Планшет повторяет десктопную поверхность по доменам, которые нужны
// цеху (рамка владельца: docs/plans/android-tablet-client-2026-08.md, §10-12).
// Для этих доменов действует строгое правило: ВСЕ каналы домена из preload
// обязаны быть зарегистрированы в мосте. Исключения перечислены явно и с
// причиной — молчаливое исключение («на планшете этого нет») не считается
// причиной: его надо назвать.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { TABLET_CHANNEL_RULES, TABLET_DOMAIN_EXCEPTIONS } from './tabletDomains.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');
const preloadPath = resolve(repoRoot, 'electron-app/src/preload/index.ts');
const wiringPath = resolve(here, 'ipcWiring.ts');
const filesBridgePath = resolve(here, 'filesBridge.ts');

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

/**
 * Текст без комментариев.
 *
 * Обязательно: иначе закомментированная строка вызова читается как вызов, а
 * сторож перестаёт ловить ровно тот дефект, ради которого написан (домен
 * отключён комментарием — а каналы «ещё зарегистрированы»).
 *
 * Сканер, а не регулярка: в этом репозитории `/*` встречается ВНУТРИ строк
 * комментария (например `ipc/register/*-модули` в шапке моста), и регулярка
 * «блок-комментарий» оттуда съедала пол-файла вместе со всеми импортами.
 */
function stripComments(text: string): string {
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i] as string;
    const next = text[i + 1];
    if (ch === '/' && next === '/') {
      while (i < n && text[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      out += ch;
      i++;
      while (i < n) {
        out += text[i];
        if (text[i] === '\\') {
          out += text[i + 1] ?? '';
          i += 2;
          continue;
        }
        if (text[i] === quote) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * Домены preload, каналы которых планшет обязан поддерживать целиком.
 *
 * Список — по факту зарегистрированных в мосте доменов плюс `engines`
 * (карточки двигателей и пакетный приём): домен карточек на планшете — ровно
 * то, что нужно в цеху (дефектовка и комплектность), и он закрыт жалобой
 * владельца (промт #111). Ключ — корневая часть канала (`drafts:` → `drafts`).
 */
const TABLET_REQUIRED_ROOTS: readonly string[] = [
  'access', // членство в разделах: гейт доступа
  'admin',
  'app',
  'audit',
  'auth',
  'changes',
  'checklists',
  'contracts', // «№ в договоре» в плане ПП
  'diagnostics',
  'drafts', // черновики карточек (промт #111: «черновики не открываются»)
  'employees',
  'engine',
  'engineActTemplates',
  'engines', // карточка двигателя: чтение и запись (промт #111)
  'files',
  'log',
  'logging',
  'notes',
  'ops',
  'parts',
  'presence',
  'productionProgram', // производственная программа (промт #70, #111)
  'search',
  'sections',
  'server',
  'shortcuts',
  'signatureCaptions',
  'supplyRequests',
  'sync',
  'ui',
  'warehouse',
  'warehouseLocations',
  'workOrderTemplates',
  'workOrders',
  'workSheets',
  'workshops',
];

/**
 * Исключения: каналы, которых на планшете сознательно нет.
 *
 * Формат `канал` — точный канал; `префикс:*` — все каналы префикса.
 * Причина обязательна: «на планшете этого нет» без причины — не причина.
 */
const TABLET_SURFACE_EXCEPTIONS: readonly { match: string; reason: string }[] = [
  {
    match: 'files:*',
    reason:
      'вложения на планшете идут через узкий мост android-app/src/core/filesBridge.ts: свой набор каналов (preview/original/upload/delete), десктопный домен построен вокруг путей на диске',
  },
  {
    match: 'engine:findExactByNumber',
    reason: 'канал домена «Поиск по файлам» (fileSearch) — вне рамки планшета (поиск по своей файловой папке)',
  },
  {
    match: 'engine:characteristics',
    reason: 'канал домена «Поиск по файлам» (fileSearch) — вне рамки планшета',
  },
  {
    match: 'app:navigateDeepLink',
    reason: 'deep-link десктопного клиента (внешний протокол) — на планшете нет',
  },
];

/** Имена, экспортируемые модулем (без default) — для проверки шимов. */
function exportedNames(text: string): Set<string> {
  const names = new Set<string>();
  for (const m of text.matchAll(/export\s+(?:async\s+)?(?:const|function|class|let|var)\s+([A-Za-z0-9_$]+)/g)) {
    names.add(m[1] as string);
  }
  for (const m of text.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of (m[1] as string).split(',')) {
      const name = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]?.trim();
      if (name) names.add(name);
    }
  }
  return names;
}

/** Каналы preload, которые renderer зовёт и ждёт ответа (invoke). */
function preloadInvokeChannels(): string[] {
  const text = stripComments(read(preloadPath));
  const out = new Set<string>();
  for (const m of text.matchAll(/ipcRenderer\.invoke\(\s*['"]([^'"]+)['"]/g)) out.add(m[1] as string);
  return [...out];
}

/**
 * Каналы, зарегистрированные в мосте Android.
 *
 * Считаются по ТРАНЗИТИВНОМУ графу: `ipcWiring.ts` регистрирует домены
 * функциями (`registerXxxIpc(ctx)`), а сами хэндлеры прячутся внутри
 * `electron-app/src/main/ipc/register/*`.
 *
 * Важно: считаются не просто импортированные модули, а только те, чья функция
 * регистрации ВЫЗВАНА. Импорт без вызова — это ровно тот дефект, который
 * сторож ловит: модуль в бандле есть, а хэндлер не зарегистрирован.
 */
function androidBridgeChannels(): Set<string> {
  const channels = new Set<string>();
  const seen = new Set<string>();

  const resolveLocal = (spec: string, fromFile: string): string | null => {
    if (!spec.startsWith('.')) return null;
    const base = resolve(dirname(fromFile), spec);
    const candidates = [
      base.replace(/\.js$/, '.ts'),
      `${base.replace(/\.js$/, '')}.ts`,
      resolve(base, 'index.ts'),
    ];
    for (const c of candidates) {
      try {
        readFileSync(c, 'utf8');
        return c;
      } catch {
        /* идём дальше */
      }
    }
    return null;
  };

  /** Импорты модуля: имя функции → файл, откуда она пришла. */
  const importMap = (text: string, fromFile: string): Map<string, string> => {
    const out = new Map<string, string>();
    for (const m of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)) {
      const spec = m[2] as string;
      const file = resolveLocal(spec, fromFile);
      if (!file) continue;
      for (const part of (m[1] as string).split(',')) {
        const name = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]?.trim();
        if (name) out.set(name, file);
      }
    }
    return out;
  };

  /** Функции, реально вызванные в модуле (без комментариев). */
  const calledNames = (text: string): Set<string> => {
    const out = new Set<string>();
    for (const m of text.matchAll(/\b([A-Za-z0-9_$]+)\s*\(/g)) out.add(m[1] as string);
    return out;
  };

  const queue: string[] = [wiringPath, filesBridgePath];
  while (queue.length) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    let text = '';
    try {
      text = stripComments(read(file));
    } catch {
      continue;
    }
    for (const m of text.matchAll(/ipcMain\.handle\(\s*['"]([^'"]+)['"]/g)) channels.add(m[1] as string);

    const imports = importMap(text, file);
    const called = calledNames(text);
    for (const m of text.matchAll(/from\s*['"]([^'"]+)['"]/g)) {
      const spec = m[1] as string;
      const local = resolveLocal(spec, file);
      if (!local) continue;
      // Модуль домена (`ipc/register/*`) идёт в обход только если его функция
      // регистрации вызвана: импорт без вызова — не зарегистрированный домен.
      const isDomainModule = /ipc[\\/]register[\\/]/.test(local);
      if (isDomainModule) {
        const used = [...imports.entries()].some(
          ([name, src]) => src === local && called.has(name),
        );
        if (!used) continue;
      }
      queue.push(local);
    }
  }
  return channels;
}

function isExcepted(channel: string): boolean {
  return TABLET_SURFACE_EXCEPTIONS.some((e) =>
    e.match.endsWith(':*') ? channel.startsWith(e.match.slice(0, -1)) : channel === e.match,
  );
}

const rootOf = (channel: string): string => channel.split(':')[0] ?? channel;

describe('поверхность каналов планшета', () => {
  const preload = preloadInvokeChannels();
  const bridge = androidBridgeChannels();

  it('преload и мост прочитаны (иначе сторож молчит вхолостую)', () => {
    expect(preload.length).toBeGreaterThan(100);
    expect(bridge.size).toBeGreaterThan(100);
  });

  it('каналы preload, которые зовёт renderer, зарегистрированы в мосте планшета', () => {
    const missing: string[] = [];
    for (const channel of preload) {
      if (!TABLET_REQUIRED_ROOTS.includes(rootOf(channel))) continue;
      if (isExcepted(channel)) continue;
      if (!bridge.has(channel)) missing.push(channel);
    }
    expect(
      missing,
      'каналы preload не зарегистрированы в мосте планшета — раздел откроется пустым или вернёт «недоступно на планшете»',
    ).toEqual([]);
  });

  it('каждый домен планшетной рамки реально подключён к мосту', () => {
    const missingRoots: string[] = [];
    for (const root of TABLET_REQUIRED_ROOTS) {
      const any = [...bridge].some((c) => rootOf(c) === root);
      if (!any) missingRoots.push(root);
    }
    expect(
      missingRoots,
      'домен из планшетной рамки не зарегистрирован в мосте — страница откроется пустой',
    ).toEqual([]);
  });

  it('исключения объявлены явно и с причиной', () => {
    for (const e of TABLET_SURFACE_EXCEPTIONS) {
      expect(e.reason.trim().length, `у исключения ${e.match} нет причины`).toBeGreaterThan(20);
    }
  });

  it('шим electron покрывает то, что тянут подключённые модули карточек', () => {
    // Карточки двигателей и пакетный приём подключены к мосту недавно: их
    // сервисы тянут `node:crypto` и общую БД — если шим не покрывает именованный
    // импорт, сборка APK падает на rollup («X is not exported by …»).
    const shimPath = resolve(repoRoot, 'android-app/src/shims/electron.ts');
    const shimExports = exportedNames(read(shimPath));
    const cardModules = [
      resolve(repoRoot, 'electron-app/src/main/ipc/register/engineCards.ts'),
      resolve(repoRoot, 'electron-app/src/main/ipc/register/engineBulkIntake.ts'),
    ];
    const uncovered: string[] = [];
    for (const file of cardModules) {
      const text = read(file);
      for (const m of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]electron['"]/g)) {
        for (const part of (m[1] as string).split(',')) {
          const name = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]?.trim();
          if (name && !shimExports.has(name)) uncovered.push(`${file}: electron.${name}`);
        }
      }
    }
    expect(uncovered, 'шим electron не покрывает импорты модулей карточек').toEqual([]);
  });

  /**
   * Гейт паритета КАНАЛОВ (промт КАРМАНА #142).
   *
   * Каждый канал preload, который зовёт renderer, обязан быть либо зарегистрирован
   * в мосте планшета, либо перекрыт мостом осознанно (канал зарегистрированного
   * домена, но физически не работает — печать/PDF, служба времени Windows), либо
   * объявлен исключением с причиной.
   *
   * Третий случай — и есть тот самый дефект, который владелец диагностировал как
   * «недостаточно прав»: канал не заведён, шим отвечает «недоступно на планшете»
   * без причины, и оператор решает, что правок не хватает.
   */
  it('каждый канал preload либо заведён в мосте, либо перекрыт с причиной', () => {
    const uncovered: string[] = [];
    for (const channel of preload) {
      if (bridge.has(channel)) continue;
      const coveredByRule = TABLET_CHANNEL_RULES.some((r) => r.channel === channel);
      const coveredByException = TABLET_DOMAIN_EXCEPTIONS.some((e) =>
        e.channelPrefixes.some((p) => channel === p || channel.startsWith(p)),
      );
      if (coveredByRule || coveredByException) continue;
      uncovered.push(channel);
    }
    expect(
      uncovered,
      'каналы preload не заведены в мосте планшета и не объявлены исключением — на планшете они «недоступно» без причины',
    ).toEqual([]);
  });

  it('каналы, объявленные исключением, действительно не заведены (иначе исключение устарело)', () => {
    const stale: string[] = [];
    for (const e of TABLET_DOMAIN_EXCEPTIONS) {
      for (const prefix of e.channelPrefixes) {
        if (prefix.endsWith(':')) {
          for (const channel of bridge) {
            if (channel.startsWith(prefix)) stale.push(channel);
          }
        } else if (bridge.has(prefix)) {
          stale.push(prefix);
        }
      }
    }
    expect(stale, 'канал объявлен исключением, но он заведён в мосте — уберите исключение').toEqual([]);
  });
});
