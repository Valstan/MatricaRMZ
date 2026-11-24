// Стенд воркера MiniMax: локальный прогон контура на заглушке «Кармана».
//
// Зачем: контур воркера (пул → профиль → агент → разбор ответа → `tool_use`)
// должен проверяться целиком и без прода: настоящих токенов Кармана на машине
// разработчика нет, а очки пула жалко. Подменяется только внешний бинарь `mcode`
// (вендорского CLI нет и на стенде быть не может) — всё остальное настоящее:
// клиент пула ходит HTTP-ом в заглушку, профиль пишется во временный каталог,
// команда CLI собирается и ответ разбирается настоящим `runAgent`.
//
// Прод не трогаем, наружу никуда не ходим: заглушка и воркер слушают 127.0.0.1
// на случайных портах, токены — константы стенда (настоящих в коде нет).
//
// Запуск:
//   corepack pnpm -F @matricarmz/backend-api minimax:worker-stand
//
// Код возврата: 0 — все сценарии прошли, 1 — что-то провалилось.

import { runStand, type ScenarioResult } from '../minimaxWorker/stand/scenario.js';

function printResult(result: ScenarioResult): void {
  console.log(`\n--- Сценарий «${result.title}»`);
  for (const line of result.lines) console.log(`  ${line}`);
  for (const check of result.checks) {
    console.log(`  ${check.ok ? '[ok]  ' : '[FAIL]'} ${check.label}`);
  }
  console.log(`  ИТОГ: ${result.ok ? 'пройден' : 'ПРОВАЛЕН'}`);
}

async function main(): Promise<number> {
  console.log('СТЕНД ВОРКЕРА MINIMAX — прогон на заглушке «Кармана»');
  console.log('настоящие: клиент пула, профиль, разбор ответа, tool_use, HTTP-слой;');
  console.log('подменён только бинарь mcode (вендорского CLI на машине нет).');

  const results = await runStand();
  for (const result of results) printResult(result);

  const failed = results.filter((r) => !r.ok);
  const checks = results.reduce((sum, r) => sum + r.checks.length, 0);

  console.log('\nЧТО ПРОВЕРЕНО');
  console.log('  - успех: пул отдал аккаунт, агент ответил, ответ разобран в text и tool_use;');
  console.log('  - пустой пул: 503 pool_empty, агент не запускался;');
  console.log('  - нет пары токенов: 503 pool_no_tokens — причина видна в ответе;');
  console.log('  - отказ аккаунта: аккаунт выброшен, взят следующий, запрос повторён;');
  console.log('  - продление: цепочку входа продлили, новый аккаунт не брали.');
  console.log(
    `\nСценариев: ${results.length}, проверок: ${checks}, провалено сценариев: ${failed.length}`,
  );

  return failed.length ? 1 : 0;
}

main().then(
  (code) => {
    process.exitCode = code;
    // stdout в пайпе асинхронный — сначала сбрасываем отчёт, потом выходим.
    process.stdout.write('\n', () => process.exit(code));
  },
  (e) => {
    console.error('стенд упал:', String(e));
    process.stdout.write('\n', () => process.exit(1));
  },
);
