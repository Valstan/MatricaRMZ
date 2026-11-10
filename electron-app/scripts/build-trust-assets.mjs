// Готовит файлы доверия для поставки в клиент (ADR-0003).
//
// Что кладём и зачем:
//   matrixarmz-rootca.cer        — ПУБЛИЧНАЯ часть корня Матрицы. Её ставит клиент
//                                  (в профиль пользователя) и администратор (в машинные
//                                  хранилища). Приватного ключа здесь нет и быть не может:
//                                  он живёт только в CI.
//   install-root-on-machine.ps1   — установка корня (уже есть в scripts/signing, здесь та же
//                                  копия, что едет в архив помощника: один рецепт на проект).
//   trust-root-probe.ps1          — read-only опрос: где корень и подписан ли текущий EXE.
//
// Почему отдельной папкой build/trust, а не прямо в resources:
//   electron-builder кладёт extraResources поштучно, а скрипт установки ищет .cer РЯДОМ с
//   собой (Join-Path $PSScriptRoot). Значит, все три файла должны лежать рядом — так они и
//   кладутся: одной папкой, одним шагом перед сборкой.
//
// Про подпись: файлы .ps1 едут в клиент как есть, и НЕПОДПИСАННЫЙ .ps1 Касперский удаляет
// на лету (M94 — так исчезал помощник). Поэтому CI подписывает их ДО сборки (шаг
// "Sign trust scripts" в release-electron-windows.yml), и копия в build/trust уже подписана.
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..', '..')
const outDir = path.resolve(here, '..', 'build', 'trust')

/** [источник в репозитории, имя в resources клиента] */
const FILES = [
  ['scripts/signing/matrixarmz-rootca.cer', 'matrixarmz-rootca.cer'],
  ['scripts/signing/install-root-on-machine.ps1', 'install-root-on-machine.ps1'],
  ['scripts/signing/trust-root-probe.ps1', 'trust-root-probe.ps1'],
]

const missing = FILES.filter(([src]) => !existsSync(path.join(repoRoot, src)))
if (missing.length) {
  throw new Error(
    `build-trust-assets: нет исходников: ${missing.map(([src]) => src).join(', ')}`,
  )
}

mkdirSync(outDir, { recursive: true })
for (const [src, name] of FILES) {
  const from = path.join(repoRoot, src)
  const to = path.join(outDir, name)
  copyFileSync(from, to)
  console.log(`build-trust-assets: ${name} (${statSync(to).size} байт)`)
}

console.log(`build-trust-assets: готово в ${outDir}`)
