import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

// КОНТРАКТ РАНТАЙМА: клиент ↔ CI-скрипт сборки.
//
// Локальный рантайм MiniMax едет в инсталляторе как extraResource, и читает его
// клиент по ФАЙЛАМ: `config.json` (адрес и токен клиентской комнаты «Кармана» +
// относительные пути к рантайму) рядом с `bin/node.exe` и пакетом MiniMax Code.
//
// Расхождение между скриптом и клиентом не видно ни в одном существующем гейте:
// скрипт напишет поле, которого клиент не читает (рантайм «не настроен», и всё
// молчит), либо клиент прочитает поле, которого нет в скрипте (то же самое). Поэтому
// контракт закреплён здесь — по тексту обоих файлов.
//
// Что НЕ проверяем: сам запуск рантайма на машине парка — это приёмка (живой прогон
// 28.11.2026), а не гейт.

const REPO = resolve(__dirname, '../../../../..');

const CLIENT_CONFIG = readFileSync(resolve(REPO, 'electron-app/src/main/services/localMiniMax/config.ts'), 'utf8').replace(/\r\n/g, '\n');
const STAGE_SCRIPT = readFileSync(resolve(REPO, 'scripts/ci/stage-local-minimax-runtime.mjs'), 'utf8').replace(/\r\n/g, '\n');
const SIGN_SCRIPT = readFileSync(resolve(REPO, 'scripts/signing/ci-sign-artifacts.ps1'), 'utf8').replace(/\r\n/g, '\n');
const WORKFLOW = readFileSync(resolve(REPO, '.github/workflows/release-electron-windows.yml'), 'utf8').replace(/\r\n/g, '\n');

/** Ключи, которые клиент читает из бандла (`RuntimeBundle`). */
const BUNDLE_KEYS = ['karmanUrl', 'karmanToken', 'project', 'deepseekApiKey', 'node', 'mcode'] as const;

describe('контракт рантайма локального звена (клиент ↔ CI)', () => {
  it('клиент читает из бандла те же поля, что скрипт и записывает', () => {
    for (const key of BUNDLE_KEYS) {
      expect(CLIENT_CONFIG, `клиент не читает поле ${key}`).toContain(key);
      expect(STAGE_SCRIPT, `скрипт не пишет поле ${key}`).toContain(key);
    }
  });

  it('клиентская комната одна и та же в клиенте и в скрипте', () => {
    expect(CLIENT_CONFIG).toContain('matricarmz-clients');
    expect(STAGE_SCRIPT).toContain('matricarmz-clients');
  });

  it('пути в конфиге относительные: клиент разрешает их от каталога бандла', () => {
    // Абсолютный путь в config.json уехал бы в config.json другого компьютера.
    expect(STAGE_SCRIPT).toMatch(/node:\s*NODE_REL|mcode:\s*MCODE_REL/);
    expect(STAGE_SCRIPT).not.toMatch(/node:\s*['"][A-Za-z]:\\/);
    expect(STAGE_SCRIPT).not.toMatch(/mcode:\s*['"][A-Za-z]:\\/);
    expect(CLIENT_CONFIG).toContain("runtimePath(baseDir");
  });

  it('скрипт кладёт ровно те файлы, на которые ссылается конфиг', () => {
    // Node рантайма — в bin/, пакет MiniMax Code — в mcode/node_modules/.
    expect(STAGE_SCRIPT).toContain('bin/node.exe');
    expect(STAGE_SCRIPT).toContain('mcode/node_modules/@minimax-ai/code/cli.js');
    expect(STAGE_SCRIPT).toContain("copyFileSync(process.execPath");
    expect(STAGE_SCRIPT).toContain("join(BUNDLE, 'mcode'");
  });

  it('Node рантайма не ниже требуемого, а версия MiniMax Code закреплена', () => {
    // Рантайм MiniMax Code требует Node 22.19+; версия пакета — та, на которой снят
    // живой прогон (28.11.2026).
    expect(STAGE_SCRIPT).toContain('NODE_MIN');
    expect(STAGE_SCRIPT).toMatch(/MCODE_VERSION\s*=\s*'0\.7\.4'/);
  });

  it('тяжёлые драйверы computer-use вырезаются: инсталлятор не должен расти на 231 МБ', () => {
    expect(STAGE_SCRIPT).toContain('embedded');
    expect(STAGE_SCRIPT).toContain('@trycua');
    // Вырезание обязано быть ПОСЛЕ установки пакета, а не «если нет папки».
    expect(STAGE_SCRIPT).toMatch(/rmSync\(embedded/);
  });

  it('рантайм проверяется запуском до сборки инсталлятора', () => {
    // Рантайм, который не запускается, хуже отсутствия рантайма: клиент молчал бы
    // «не настроен», а на самом деле рантайм сломан.
    expect(STAGE_SCRIPT).toContain('--version');
    expect(STAGE_SCRIPT).toMatch(/fail\(/);
  });

  it('CI собирает рантайм и подписывает его ДО electron-builder', () => {
    const stageAt = WORKFLOW.indexOf('stage-local-minimax-runtime.mjs');
    const signAt = WORKFLOW.indexOf('-Mode Runtime');
    const buildAt = WORKFLOW.indexOf('electron-builder --win');
    expect(stageAt, 'в workflow нет шага сборки рантайма').toBeGreaterThan(-1);
    expect(signAt, 'в workflow нет подписи рантайма').toBeGreaterThan(-1);
    expect(buildAt, 'в workflow нет шага сборки инсталлятора').toBeGreaterThan(-1);
    expect(stageAt).toBeLessThan(buildAt);
    expect(signAt).toBeLessThan(buildAt);
  });

  it('подпись рантайма — отдельным режимом, и только Windows-файлы', () => {
    expect(SIGN_SCRIPT).toContain("'Runtime'");
    expect(SIGN_SCRIPT).toContain('ValidateSet');
    // .node/.dll для macOS и Linux — не PE: signtool их не подпишет.
    expect(SIGN_SCRIPT).toContain('darwin');
  });

  it('токен комнаты едет из секрета, а не из репозитория', () => {
    expect(WORKFLOW).toContain('KARMAN_CLIENT_TOKEN');
    expect(WORKFLOW).toContain('${{ secrets.');
    // Каталог бандла в .gitignore — токен в git не попадает НИКОГДА.
    expect(readFileSync(resolve(REPO, '.gitignore'), 'utf8')).toContain('electron-app/build/local-minimax/');
  });
});
