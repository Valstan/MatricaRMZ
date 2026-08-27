// Packs the Kaspersky helper (scripts/client-ops) into a PASSWORD-PROTECTED zip that
// the installer drops on the operator's desktop (see installer/installer.nsh,
// InstallKasperskyHelper).
//
// Why encrypted, and why THIS encryption:
//  * Kaspersky cannot look inside an encrypted archive, so it cannot delete the
//    unsigned .ps1 by heuristic on sight (GOTCHAS M94: the bare script is eaten the
//    moment it lands, before any exclusion exists). The password is not a secret — it
//    is printed on the desktop readme and in the guide; its only job is to make the
//    archive opaque to the scanner. Hence a trivial "111".
//  * Traditional ZipCrypto (-mem=ZipCrypto), NOT AES: Windows' built-in Explorer
//    extracts a ZipCrypto archive with a password prompt and no third-party tool,
//    which is all a park operator has. An AES zip would need 7-Zip/WinRAR installed.
//
// Built via the 7za binary from the 7zip-bin dev-dependency — a proven tool, not
// hand-rolled crypto shipped to the whole fleet. Run standalone for testing, or via
// the electron-builder beforePack hook (build/before-pack.cjs) so every build path —
// local `pnpm dist` and the CI installer job alike — produces it with one wire.
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  mkdtempSync, mkdirSync, copyFileSync, rmSync, existsSync, statSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import sevenBin from '7zip-bin'

const PASSWORD = '111'
const INNER_DIR = 'kaspersky-matrica' // top-level folder inside the zip → clean extract
// Operators do not need the acceptance tests; everything else is useful on a park machine.
const FILES = [
  'kaspersky-matrica.ps1',
  'guide.ru.md',
  'README.md',
  'Запустить.cmd',
  'Запустить-от-администратора.cmd',
]

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..', '..')
const srcDir = path.join(repoRoot, 'scripts', 'client-ops')
const outDir = path.resolve(here, '..', 'build', 'kaspersky')
const outZip = path.join(outDir, 'kaspersky-matrica.zip')

const missing = FILES.filter((f) => !existsSync(path.join(srcDir, f)))
if (missing.length) {
  throw new Error(`build-kaspersky-zip: missing source files in ${srcDir}: ${missing.join(', ')}`)
}

// 7za APPENDS to an existing archive; start from a clean output so a rebuild never
// carries a stale entry (e.g. a file since removed from FILES).
mkdirSync(outDir, { recursive: true })
if (existsSync(outZip)) rmSync(outZip)

const stage = mkdtempSync(path.join(tmpdir(), 'kmz-zip-'))
try {
  const inner = path.join(stage, INNER_DIR)
  mkdirSync(inner)
  for (const f of FILES) copyFileSync(path.join(srcDir, f), path.join(inner, f))

  // cwd = stage so the archive stores paths as "kaspersky-matrica/<file>".
  execFileSync(
    sevenBin.path7za,
    ['a', '-tzip', '-mem=ZipCrypto', `-p${PASSWORD}`, '-bso0', '-bsp0', outZip, INNER_DIR],
    { cwd: stage, stdio: ['ignore', 'inherit', 'inherit'] },
  )
} finally {
  rmSync(stage, { recursive: true, force: true })
}

const size = statSync(outZip).size
if (size <= 0) throw new Error(`build-kaspersky-zip: produced an empty archive at ${outZip}`)
console.log(`build-kaspersky-zip: wrote ${outZip} (${size} bytes, ZipCrypto, ${FILES.length} files)`)
