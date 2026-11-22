// electron-builder beforePack hook. Runs before the app is packed, which is before
// extraResources are copied — so anything generated here into build/ is picked up by
// the extraResources declared in package.json.
//
// It builds the password-protected Kaspersky-helper archive (see
// scripts/build-kaspersky-zip.mjs for the why). Unlike the watchdog — built by a
// dedicated CI step because it needs the Go toolchain — the archive needs only Node
// and the 7zip-bin dev-dependency, present in every build path, so a single hook here
// covers local `pnpm dist` and the CI installer job without a separate step to forget.
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

exports.default = async function beforePack() {
  const script = path.join(__dirname, '..', 'scripts', 'build-kaspersky-zip.mjs')
  // Fail the build loudly if the archive cannot be produced: shipping an installer
  // that silently lacks the helper is worse than a red build.
  execFileSync(process.execPath, [script], { stdio: 'inherit' })

  // Рантайм локального звена MiniMax (D-243/D-244): рантайм MiniMax Code с Node.js
  // и конфиг клиентской комнаты «Кармана». Настоящий пакет кладёт CI (в нём токен
  // комнаты — секрет, в git ему не место); локальная сборка без него получает пустой
  // конфиг, и клиент честно пишет «локальный модуль не настроен», считая сервер.
  const runtimeDir = path.join(__dirname, 'local-minimax')
  fs.mkdirSync(path.join(runtimeDir, 'bin'), { recursive: true })
  const configPath = path.join(runtimeDir, 'config.json')
  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(
      configPath,
      JSON.stringify({ karmanUrl: '', karmanToken: '', project: 'matricarmz-clients', deepseekApiKey: '' }, null, 2),
      'utf8',
    )
  }
}
