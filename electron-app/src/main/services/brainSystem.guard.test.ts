import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Сторож мозга проекта (промт КАРМАНА #198).
 *
 * Мозг проекта — это указатель на канон (конституция · линза · совет), а не его копия.
 * Копия протухает молча: правило «изменился проект — изменилась линза и реестр» живёт
 * в правилах проекта, но держится только если слои на месте и связаны. Здесь четыре связи
 * проверяются машинно:
 *
 *  1. **слои ↔ указатель** — `docs/BRAIN.md` существует и ссылается на каждый слой
 *     (конституция, карта, реестр глобальных модулей, реестр ролей, протокол, приём);
 *  2. **реестр ↔ уставы** — у каждой роли есть строка в реестре и файл устава; осиротевшего
 *     устава нет (роль не заведена «в папке» без записи в реестре);
 *  3. **приём ↔ реестр** — в порядке приёма названы все роли приёма: маршрут и реестр
 *     не разошлись;
 *  4. **правило обновления** — фраза «изменился проект — изменилась линза и реестр» есть
 *     в правилах проекта (`AGENTS.md`), иначе правило живёт только в голове.
 *
 * Смысл гейта — не «переписать мозг», а не дать ему разъехаться: устаревшая карта врёт
 * уверенно, и агент пошёл строить модуль, который уже есть.
 */

const REPO = resolve(__dirname, '../../../..');
const DOCS = resolve(REPO, 'docs');

const BRAIN_PATH = resolve(DOCS, 'BRAIN.md');
const INTAKE_PATH = resolve(DOCS, 'PROMPT_INTAKE.md');
const ROSTER_PATH = resolve(DOCS, 'advisors/ROSTER.md');
const PROTOCOL_PATH = resolve(DOCS, 'council/PROTOCOL.md');
const ADVISORS_DIR = resolve(DOCS, 'advisors');

/** Слои мозга: без любого из них «указатель» указывает в пустоту. */
const LAYERS = [
  'docs/CONSTITUTION.md',
  'docs/CODEBASE_MAP.md',
  'docs/GLOBAL_MODULES.md',
  'docs/advisors/ROSTER.md',
  'docs/council/PROTOCOL.md',
  'docs/PROMPT_INTAKE.md',
];

/**
 * Роли приёма (промт КАРМАНА #198). `slug` совпадает с папкой в `docs/advisors/`.
 */
const INTAKE_ROLES = [
  'coordinator',
  'scout',
  'coder',
  'reviewer',
  'tester',
  'anthropologist',
  'jester',
  'efficiency',
  'necessity',
];

/** Потолок устава: устав читают перед каждым советом — длинный устав не читают. */
const CHARTER_BYTE_LIMIT = 8 * 1024;

const read = (path: string) => readFileSync(path, 'utf8');

describe('мозг проекта: слои на месте', () => {
  it('каждый слой существует на диске', () => {
    const missing = LAYERS.filter((layer) => !existsSync(resolve(REPO, layer)));
    expect(missing).toEqual([]);
  });

  it('указатель ссылается на все слои (а не пересказывает их)', () => {
    const brain = read(BRAIN_PATH);
    const missing = LAYERS.filter((layer) => !brain.includes(layer.replace(/^docs\//, '')) && !brain.includes(layer));
    expect(missing).toEqual([]);
  });

  it('в указателе нет второй копии конституции', () => {
    // Конституция — 13 статей; если её текст расплылся в указателе, значит появилась копия
    // канона (ADR-0011: две копии расходятся молча).
    const brain = read(BRAIN_PATH);
    expect(brain).not.toContain('Эргономика оператора важнее удобства разработчика');
    expect(brain).toContain('CONSTITUTION.md');
  });
});

describe('мозг проекта: реестр ролей и уставы', () => {
  it('у каждой роли приёма есть строка в реестре и файл устава', () => {
    const roster = read(ROSTER_PATH);
    const broken = INTAKE_ROLES.filter(
      (slug) => !roster.includes(`${slug}/CHARTER.md`) || !existsSync(resolve(ADVISORS_DIR, slug, 'CHARTER.md')),
    );
    expect(broken).toEqual([]);
  });

  it('нет осиротевшего устава: каждая папка советника названа в реестре', () => {
    const roster = read(ROSTER_PATH);
    const slugs = readdirSync(ADVISORS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    const orphans = slugs.filter((slug) => !roster.includes(`${slug}/CHARTER.md`));
    expect(orphans).toEqual([]);
  });

  it('устав не толще потолка', () => {
    const tooFat: string[] = [];
    for (const slug of readdirSync(ADVISORS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)) {
      const charter = resolve(ADVISORS_DIR, slug, 'CHARTER.md');
      if (!existsSync(charter)) continue;
      const bytes = statSync(charter).size;
      if (bytes > CHARTER_BYTE_LIMIT) tooFat.push(`${slug}: ${bytes}`);
    }
    expect(tooFat).toEqual([]);
  });
});

describe('мозг проекта: приём и реестр не разошлись', () => {
  it('в порядке приёма названы все роли приёма', () => {
    const intake = read(INTAKE_PATH);
    const missing = INTAKE_ROLES.filter((slug) => !intake.includes(slug));
    expect(missing).toEqual([]);
  });

  it('в порядке приёма описаны три маршрута и признак «план выполнен»', () => {
    const intake = read(INTAKE_PATH);
    for (const marker of ['Мелочь', 'Крупное', 'Спорное', 'план выполнен']) {
      expect(intake).toContain(marker);
    }
  });

  it('места хранения опыта, названные в приёме, существуют', () => {
    const intake = read(INTAKE_PATH);
    const stores = ['docs/gotchas', 'docs/pending', 'docs/plans', 'docs/council', 'docs/COMPLETED.md', 'docs/advisors'];
    const missing = stores.filter((store) => !intake.includes(store) || !existsSync(resolve(REPO, store)));
    expect(missing).toEqual([]);
  });

  it('протокол совета ссылается на порядок приёма', () => {
    expect(read(PROTOCOL_PATH)).toContain('PROMPT_INTAKE.md');
  });
});

describe('мозг проекта: правило обновления', () => {
  it('правило «изменился проект — изменилась линза и реестр» есть в правилах проекта', () => {
    const agents = read(resolve(REPO, 'AGENTS.md'));
    expect(agents).toContain('изменился проект');
    expect(agents).toContain('линза');
  });

  it('правило есть и в указателе, и в реестре — а не в одном месте', () => {
    expect(read(BRAIN_PATH)).toContain('изменился проект');
    expect(read(ROSTER_PATH)).toContain('изменился проект');
  });

  it('скилл приёма существует и ведёт по шагам, а не дублирует канон', () => {
    const skillPath = resolve(REPO, '.claude/skills/prompt-intake/SKILL.md');
    expect(existsSync(skillPath)).toBe(true);
    const skill = read(skillPath);
    expect(skill).toContain('docs/PROMPT_INTAKE.md');
    expect(skill).toContain('docs/advisors/ROSTER.md');
  });
});
