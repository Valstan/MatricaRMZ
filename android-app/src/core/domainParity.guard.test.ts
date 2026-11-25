// Гейт паритета доменов: десктоп ↔ планшет (промт КАРМАНА #142).
//
// Зачитка владельца 25.11.2026: «планшетная версия — полный функционал, все
// модули; версия для компьютера — копия планшетной». Значит список доменов IPC
// на десктопе и на планшете должен СОВПАДАТЬ, кроме оговорённого списка
// исключений — и каждое исключение обязано называть причину.
//
// Что ловит гейт: ровно тот дефект, который владелец диагностировал как
// «недостаточно прав». Домен есть в коде, раздел есть в меню, а канал в мосте
// планшета не заведён: шим отвечает «недоступно на планшете», renderer печатает
// «Ошибка сохранения: …» — и оператор решает, что запись не уходит. Так была
// потеряна запись карточки двигателя (промт #111), так же «не открывались
// черновики», так же «не открывалась производственная программа».
//
// Без этого гейта расхождение вернётся: стоит кому-то добавить домен на
// десктопе — и он молча не заработает на планшете.
//
// Проверка СТАТИЧЕСКАЯ (по коду регистрации), а не функциональная: «канал из
// домена есть в мосте?» — это про поверхность; «работает ли он» — это смоук
// (bridge.smoke.test.ts).
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { TABLET_CHANNEL_RULES, TABLET_DOMAIN_EXCEPTIONS, tabletExceptionDomains } from './tabletDomains.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');

const DESKTOP_REGISTRY = resolve(repoRoot, 'electron-app/src/main/ipc/registerIpc.ts');
const TABLET_WIRING = resolve(repoRoot, 'android-app/src/core/ipcWiring.ts');
const PRELOAD = resolve(repoRoot, 'electron-app/src/preload/index.ts');

/** Домены, которых на десктопе нет, а на планшете есть — свои мосты. */
const TABLET_NATIVE_DOMAINS: readonly string[] = ['AndroidFiles'];

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

/** Имена доменов из вызовов `registerXxxIpc(...)`. */
function registeredDomains(source: string): Set<string> {
  const out = new Set<string>();
  for (const m of source.matchAll(/\bregister([A-Za-z0-9]+)Ipc\s*\(/g)) out.add(m[1] as string);
  return out;
}

/** Каналы preload, которые зовёт renderer. */
function preloadChannels(): string[] {
  const text = read(PRELOAD);
  const out = new Set<string>();
  for (const m of text.matchAll(/ipcRenderer\.invoke\(\s*['"]([^'"]+)['"]/g)) out.add(m[1] as string);
  return [...out];
}

const desktop = registeredDomains(read(DESKTOP_REGISTRY));
const tablet = registeredDomains(read(TABLET_WIRING));
const exceptions = tabletExceptionDomains();
const preload = preloadChannels();

describe('паритет доменов: десктоп ↔ планшет', () => {
  it('реестры прочитаны (иначе гейт молчит вхолостую)', () => {
    expect(desktop.size, 'десктопных доменов подозрительно мало').toBeGreaterThan(40);
    expect(tablet.size, 'планшетных доменов подозрительно мало').toBeGreaterThan(40);
  });

  it('каждый домен десктопа заведён на планшете — кроме объявленных исключений', () => {
    const missing = [...desktop].filter((d) => !tablet.has(d) && !exceptions.has(d)).sort();
    expect(
      missing,
      'домен заведён на десктопе, но не в мосте планшета — на планшете он молча не работает',
    ).toEqual([]);
  });

  it('на планшете нет «своих» доменов, которых нет на десктопе', () => {
    const extra = [...tablet].filter((d) => !desktop.has(d) && !TABLET_NATIVE_DOMAINS.includes(d)).sort();
    expect(extra, 'домен есть только на планшете — расхождение в другую сторону').toEqual([]);
  });

  it('исключение не устарело: домен действительно НЕ заведён на планшете', () => {
    const stale = TABLET_DOMAIN_EXCEPTIONS.filter((e) => tablet.has(e.domain)).map((e) => e.domain);
    expect(stale, 'домен объявлен исключением, но на планшете он подключён — уберите исключение').toEqual([]);
  });

  it('у каждого исключения есть причина — «нет на планшете» без причины не причина', () => {
    for (const e of TABLET_DOMAIN_EXCEPTIONS) {
      expect(e.reason.trim().length, `у исключения ${e.domain} нет причины`).toBeGreaterThan(20);
    }
  });

  it('у каждого исключения объявлены каналы — иначе отказ не найдёт причину', () => {
    for (const e of TABLET_DOMAIN_EXCEPTIONS) {
      expect(e.channelPrefixes.length, `у исключения ${e.domain} нет префиксов каналов`).toBeGreaterThan(0);
    }
  });

  it('префиксы исключений накрывают реальные каналы preload', () => {
    // Исключение про канал, которого нет, — мёртвая запись: и отказ не найдёт
    // причину, и гейт не заметит, что домен на самом деле подключили.
    for (const e of TABLET_DOMAIN_EXCEPTIONS) {
      const hit = preload.filter((c) => e.channelPrefixes.some((p) => c === p || c.startsWith(p)));
      expect(hit.length, `исключение ${e.domain} не накрывает ни одного канала preload`).toBeGreaterThan(0);
    }
  });

  it('каналы, перекрытые мостом, есть в preload (иначе правило — мёртвое)', () => {
    const unknown = TABLET_CHANNEL_RULES.filter((r) => !preload.includes(r.channel)).map((r) => r.channel);
    expect(unknown, 'перекрыт канал, которого нет в preload — правило ничего не делает').toEqual([]);
  });
});
