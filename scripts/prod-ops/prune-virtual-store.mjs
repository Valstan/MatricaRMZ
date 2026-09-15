#!/usr/bin/env node
// Съём клиентской обвязки из node_modules прод-бокса.
//
// Прод исполняет только `backend-api` (+ `shared`/`ledger` как workspace-зависимости) и раздаёт
// статику `web-admin`. Клиентские пакеты там не собираются НИКОГДА (AGENTS.md §Release process),
// но `pnpm install` в корне монорепо ставит зависимости всех воркспейс-пакетов — и самое тяжёлое
// на диске оказывается тем, что этой машине не нужно: `app-builder-bin` (electron-builder, две
// версии по 207 МБ), Capacitor/stencil планшета, `electron`, `better-sqlite3-multiple-ciphers`.
//
// Скрипт считает ЗАМЫКАНИЕ пакетов, достижимых из серверных корней по симлинкам виртуального
// стора, и убирает всё недостижимое. Это не «список на глаз»: пакет остаётся, если до него есть
// путь по графу зависимостей от серверного корня, и уходит, если пути нет.
//
//   node scripts/prod-ops/prune-virtual-store.mjs            # сухой прогон: что и сколько
//   node scripts/prod-ops/prune-virtual-store.mjs --stage    # отнести в сторону (обратимо)
//   node scripts/prod-ops/prune-virtual-store.mjs --restore   # вернуть отложенное
//   node scripts/prod-ops/prune-virtual-store.mjs --drop      # удалить отложенное
//   corepack pnpm store prune                                 # <- только это освобождает место
//
// ⚠️ Место освобождает НЕ удаление `.pnpm`, а `pnpm store prune` после него: файлы в
// `node_modules` — хардлинки в стор, и пока на инод ссылается стор, блоки заняты (GOTCHAS M132).
//
// ⚠️ После съёма корневой `pnpm install` на проде вернёт всё обратно. Если релиз добавил
// РАНТАЙМОВУЮ зависимость бэкенда — ставить фильтрованно (`--filter "@matricarmz/backend-api..."`)
// и прогнать этот скрипт заново.
//
// Восстановление в любом случае — `corepack pnpm install` (нужна сеть): ничего уникального
// скрипт не удаляет, всё восстановимо из реестра.

import { promises as fs } from 'node:fs'
import path from 'node:path'

const REPO = process.env.MATRICA_REPO_DIR || path.join(process.env.HOME || '', 'MatricaRMZ')
const PNPM_DIR = path.join(REPO, 'node_modules', '.pnpm')
const STAGE = path.join(REPO, 'node_modules', '.pnpm-doomed')
const ROOTS = (process.env.MATRICA_PRUNE_ROOTS || 'backend-api,shared,ledger,web-admin').split(',')

const mode = process.argv.includes('--stage')
  ? 'stage'
  : process.argv.includes('--restore')
    ? 'restore'
    : process.argv.includes('--drop')
      ? 'drop'
      : 'dry'

if (mode === 'restore') {
  const back = await fs.readdir(STAGE)
  for (const id of back) await fs.rename(path.join(STAGE, id), path.join(PNPM_DIR, id))
  await fs.rm(STAGE, { recursive: true, force: true })
  console.log(`возвращено каталогов: ${back.length}`)
  process.exit(0)
}

if (mode === 'drop') {
  await fs.rm(STAGE, { recursive: true, force: true })
  console.log('отложенное удалено; место освободит `corepack pnpm store prune`')
  process.exit(0)
}

const kept = new Set()

async function listPackageLinks(dir) {
  // Пути пакетов внутри node_modules-подобного каталога, с раскрытием @scope/name вторым уровнем.
  const out = []
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    if (e.name === '.bin' || e.name === '.pnpm' || e.name === '.modules.yaml') continue
    const full = path.join(dir, e.name)
    if (e.name.startsWith('@')) {
      let inner
      try {
        inner = await fs.readdir(full, { withFileTypes: true })
      } catch {
        continue
      }
      for (const i of inner) out.push(path.join(full, i.name))
    } else {
      out.push(full)
    }
  }
  return out
}

function virtualIdOf(realPath) {
  // .pnpm/<id>/node_modules/<name>  ->  <id>
  const rel = path.relative(PNPM_DIR, realPath)
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null
  const id = rel.split(path.sep)[0]
  return id && id !== 'node_modules' ? id : null
}

async function visit(linkPath) {
  let real
  try {
    real = await fs.realpath(linkPath)
  } catch {
    return // висячий симлинк — обходить нечего
  }
  const id = virtualIdOf(real)
  if (!id || kept.has(id)) return
  kept.add(id)
  // Зависимости пакета лежат рядом с ним: .pnpm/<id>/node_modules/*
  for (const link of await listPackageLinks(path.join(PNPM_DIR, id, 'node_modules'))) {
    await visit(link)
  }
}

const missingRoots = []
for (const root of ROOTS) {
  const nm = path.join(REPO, root, 'node_modules')
  try {
    await fs.access(nm)
  } catch {
    missingRoots.push(root)
    continue
  }
  for (const link of await listPackageLinks(nm)) await visit(link)
}

// Корневой node_modules — тоже корень: там инструменты, которыми пользуются ops-скрипты.
for (const link of await listPackageLinks(path.join(REPO, 'node_modules'))) await visit(link)

const all = (await fs.readdir(PNPM_DIR, { withFileTypes: true }))
  .filter((e) => e.isDirectory() && e.name !== 'node_modules')
  .map((e) => e.name)

const doomed = all.filter((id) => !kept.has(id))

async function dirSize(dir) {
  let total = 0
  const stack = [dir]
  while (stack.length) {
    const cur = stack.pop()
    let entries
    try {
      entries = await fs.readdir(cur, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      const full = path.join(cur, e.name)
      if (e.isDirectory()) stack.push(full)
      else if (e.isFile()) {
        try {
          total += (await fs.stat(full)).size
        } catch {
          /* битый симлинк — размера нет */
        }
      }
    }
  }
  return total
}

const mb = (n) => (n / 1024 / 1024).toFixed(1) + ' МБ'

const sized = []
for (const id of doomed) sized.push({ id, size: await dirSize(path.join(PNPM_DIR, id)) })
sized.sort((a, b) => b.size - a.size)

if (missingRoots.length) console.log('корней нет на диске:', missingRoots.join(', '))
console.log(`корни: ${ROOTS.join(', ')}`)
console.log(`всего в .pnpm: ${all.length}; достижимо: ${kept.size}; под нож: ${doomed.length}`)
console.log(`освободится: ${mb(sized.reduce((s, x) => s + x.size, 0))}`)
for (const x of sized.slice(0, 20)) console.log(`${mb(x.size).padStart(10)}  ${x.id}`)

// Сторож на случай, если корни заданы неверно (пустой ROOTS, переименованный пакет, съём до
// установки): рантаймовое имя под ножом означает, что замыкание посчитано не от тех корней.
const RUNTIME = [
  'pg',
  'drizzle-orm',
  'sharp',
  'better-sqlite3',
  'webtorrent',
  'exceljs',
  'docx',
  'jose',
  'bcryptjs',
  'helmet',
  'cors',
  'express',
  'express-rate-limit',
  'zod',
  'dotenv',
  'bittorrent-tracker',
  'create-torrent',
  'tsx',
  'esbuild',
  'node-datachannel',
]
const suspicious = doomed.filter((id) => RUNTIME.some((p) => id === p || id.startsWith(p + '@')))
if (suspicious.length) {
  console.log('!!! СТОП: под ножом рантаймовые имена:', suspicious.join(', '))
  process.exit(2)
}

if (mode === 'dry') {
  console.log('(сухой прогон; отнести в сторону — --stage)')
  process.exit(0)
}

await fs.mkdir(STAGE, { recursive: true })
let moved = 0
for (const { id } of sized) {
  await fs.rename(path.join(PNPM_DIR, id), path.join(STAGE, id))
  moved += 1
}
console.log(`отнесено в сторону: ${moved} (вернуть — --restore, удалить — --drop)`)
