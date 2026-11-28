# Часть профиля PC79: стенд lane1 для локального звена MiniMax

> Вынесено из [`stand.md`](stand.md) 28.11.2026: часть профиля подошла к потолку (40 КБ).

Стенд поднимался в ОСНОМ дереве (не в worktree): backend 3002 + БД `matricarmz_dev_lane1`,
renderer 5174, CDP 9223.

- **Backend стенда — свой лаунчер, а не `start-backend.ps1`:** `PGHOST/PGPORT/PGDATABASE=matricarmz_dev_lane1/PGUSER/PGPASSWORD`,
  `PORT=3002`, `MATRICA_API_URL=http://127.0.0.1:3002`, `corepack pnpm --filter @matricarmz/backend-api dev:no-watch`.
  Скрипт `.verifier-electron/start-lane1-backend.ps1` тоже работает, но падает, если лог занят
  прошлым процессом ⇒ свой лаунчер проще.
- **Серверный ИИ на стенде выключен по умолчанию** (`aiEnabled: false` в `/health`) ⇒ панель
  «ИИваныча» показывает «ИИваныч недоступен», даже когда локальное звено живое. Чтобы строка
  статуса показывала ветку локального звена, backend поднимают с `MATRICA_AI_DEEPSEEK_API_KEY` —
  ключ лежит в комнате «Кармана» (`GET {vault}/api/secrets` → `secrets.DEEPSEEK_API_KEY`; значение
  наружу не печатать).
- **Локальный рантайм MiniMax кладётся руками:** `electron-app/build/local-minimax/config.json`
  (каталог в `.gitignore` — секрет в git не попадёт) с
  `{"node": "C:\\Program Files\\nodejs\\node.exe", "mcode": "C:\\Users\\valstan\\AppData\\Roaming\\npm\\mcode.cmd", "project": "matricarmz-clients"}`;
  адрес «Кармана» и токен клиентской комнаты — переменными `MATRICA_KARMAN_URL` и
  `MATRICA_KARMAN_CLIENT_TOKEN` (из `%USERPROFILE%\.matricarmz-keys\`: `vault-url` и `karman-token`;
  токен пишущий, комната клиентов — `matricarmz-clients`).
- **Рантайм MiniMax Code 0.7.4 на этой машине:** npm-пакет `@minimax-ai/code` ⇒ JS-вход
  `…\npm\node_modules\@minimax-ai\code\cli.js`; npm-шим `mcode.cmd` ссылается на пакет через
  `%dp0%` (двухзаменный путь). Каталоги рантайма: `MCODE_CONFIG_DIR`, `MINIMAX_DATA_DIR`,
  `MAVIS_DATA_DIR`; **регион аккаунта — `MCODE_REGION` (`cn`/`en`, значение `prod` рантайм не
  принимает)**; вход лежит в `<dataDir>/auth/prod/<region>/mcode-public/` — **двумя файлами**:
  `auth.json` (учётные данные) и `auth-state.json` (состояние входа, без токенов внутри).
- **ABI-свап на этой машине безопасен и без `rm`:** `fsutil hardlink list` показывает, что файл
  `better_sqlite3.node` — одиночная ссылка (не hard link на стор pnpm) ⇒ `Copy-Item -Force` стор
  не портит. (`rm` в PowerShell — это алиас `Remove-Item`, а не рантаймный «в корзину»: локальный
  гейт требует своей маркировки и на `rm --` отвечает «requires the targets-only trash marker».)
- **Аккаунты пула MiniMax сейчас без баланса:** живой запрос доходит до модели и получает
  `insufficient balance (1008)` ⇒ локальный агент не ответит, пока баланс не пополнят.

Смоук приёмки кнопки «Нейросеть»:
`.claude/skills/verifier-electron/scripts/cdp-ai-section-button.mjs`.
