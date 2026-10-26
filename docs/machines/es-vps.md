# Машина: es-vps

> Профиль окружения этого компа. Читается `/start` §0.5 по hostname. Пиши сюда по мере изучения. Без секретов. Конвенция — [`README.md`](README.md).

**Hostname:** es-vps
**OS:** Linux (headless VPS, без рабочего стола — Electron-смоук здесь не поднимается)
**Папка репозитория:** `/home/valstan/repo/MatricaRMZ` (рядом `brain_matrica` — приватный клон, только чтение)
**Shell:** bash, **не логоin-shell** — `~/.local/bin` в PATH отсутствует

## Инструменты / пути

- **`node`, `npm`, `npx`, `corepack`, `gh` — в `~/.local/bin`, в PATH по умолчанию их НЕТ.** Первая строка любой команды с ними: `export PATH="$HOME/.local/bin:$PATH"`. Иначе `corepack: command not found` на ровном месте.
- **Интернет-доступ с этой машины нужен и для `npm`/`npx`** (в отличие от PC79, где всё уже скачано).

## Git и GitHub

- **`origin` этой машины — по SSH** (`git@github.com:Valstan/MatricaRMZ.git`), ключ `~/.ssh/id_ed25519_esvps`, `IdentitiesOnly yes` в `~/.ssh/config` для `Host github.com`.
- **`gh` авторизован OAuth-токеном через device flow** (26.10.2026, `gh auth login --hostname github.com --git-protocol ssh --web`). Токен лежит в `~/.config/gh/hosts.yml` вне репо. **PAT не нужен и не заводить**: прошлый PAT отозван владельцем, а `gh` с ним отвечал `HTTP 401`.
- Если push отвалился с `Permission denied (publickey)` — это новый комп/переустановленный ключ: владелец добавляет `~/.ssh/id_ed25519_esvps.pub` в GitHub → Settings → SSH keys. `gh` в этом случае не поможет.

## ⚠️ `corepack pnpm install` здесь не доживает до конца (выучено 26.10.2026)

Установка проходит резолв (стор тёплый, `reused ~975`), доходит до `Progress: … added 9` и **обрывается**: в корне ~544 МБ, но `node_modules/.bin` пуст и пакетных `node_modules` нет вовсе. Повторный `install` — то же самое, в foreground и через `setsid nohup`.

Следствие: на этой машине **не поднимаются** `shared build`, `typecheck`, `lint`, `test`, `pnpm dev` и `verifier-electron`. Гейты гонять не здесь:

- **`gh pr checks <n> --watch`** — CI и есть гейт (#125);
- **синтаксис без установки:** `export PATH="$HOME/.local/bin:$PATH" && npx --yes esbuild@0.24.0 <файл> --outfile=/dev/null` — парсит TS/TSX по расширению (без `--loader`, та форма работает только со stdin).

Частично скачанный `node_modules` в коммиты не попадает (gitignored), но и пользы не приносит — перед следующей попыткой лучше снести.

## Прочее

- **`/tmp/opencode` периодически очищается** (наблюдалось дважды за сессию 25–26.10) — логи и скрипты там не хранилище. Долгие операции: `setsid nohup … > "$HOME/<имя>.log" 2>&1 &`, лог в домашнем каталоге.
- **Прод доступен по SSH-алиасу `matricarmz`** (хост, порт, ключ — в `~/.ssh/config`). Соединение периодически отваливается на баннере: длинные операции — через `setsid nohup`, результат забирать отдельным заходом.
- **Прод-probe (read-only, авто-ярус):** `ssh -o ConnectTimeout=15 matricarmz "systemctl is-active matricarmz-backend-primary matricarmz-backend-secondary"`, `… "curl -fsk https://127.0.0.1/health"`.
- **`powershell` отсутствует** → sync-гейт `scripts/git_sync_check.ps1 -Gate` не запускается; эквивалент руками: `git status --short --branch` (должно быть чисто и без ahead), `git log --oneline -1`, `git fetch --all --prune`.
