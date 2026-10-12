# Машина `Computer` (Windows, dev-комп владельца)

Профиль окружения. Без секретов — только «как запускать».

- **PostgreSQL/psql — НЕТ.** Живой CDP-смоук (`verifier-electron`) здесь не поднять:
  нет ни сервиса postgres, ни `psql` в PATH. UI-правки — юниты + IPC-тесты +
  typecheck моста; в теле PR честно писать «смоук не гнался».
  (2026-10-12: УСТАРЕЛО — brain поднял локальный PG 17.5: `psql` в
  `C:\Program Files\PostgreSQL\17\bin\`, порт 5432 слушает, база `matricarmz`,
  пароль в `%USERPROFILE%\pg-local-credentials.json`. CDP-смоук со следующей
  сессии — гнать живо, в PR писать честно.)
- **PG-креды (`%USERPROFILE%\pg-local-credentials.json`, вне git):**
  shape `{host, port, creds: {MatricaRMZ: {login,password,db}, _super: {login,password,db}, ...}}`.
  Проектный логин изолирован (своя база, без CREATEDB) — для `setup-db.ps1`
  нужен `_super` (postgres): `$env:PG_VERIFY_USER` + `$env:PGPASSWORD` из него,
  `$env:PG_VERIFY_DB='matricarmz_dev'`. В каждом вызове shell заново
  (env между вызовами не живёт); `PATH` дополнять `...\PostgreSQL\17\bin\`.
  Dev-стенд поднят 2026-10-12: `matricarmz_dev` (снапшот + миграции + фикстуры
  verify/TEST-001), `valstan`/`valstan-dev` — суперадмин стенда.
- **MSVC/toolchain — НЕТ (2026-10-12).** `install-app-deps` падает
  (`Could not find any Visual Studio installation`): `better-sqlite3*` под
  Electron-ABI не собрать, готовых пребилдов нет. Владелец решил ставить
  VS Build Tools 2022 (`--add Microsoft.VisualStudio.Workload.VCTools
  --includeRecommended`, тихо, в фоне 12.10). До готовности —
  живой Electron-стек не поднять; бэкенд стенда (чистый Node) — можно.
  (2026-10-12 вечером: Build Tools 2022 встали в `C:\BuildTools`, MSVC 14.44 +
  Windows SDK — `install-app-deps` проходит, CDP-смоук `cdp-opencode-nodes.mjs`
  PASS. После `install-app-deps` vitest нужен Node-ABI: `corepack pnpm rebuild
  better-sqlite3` — иначе тесты падают на загрузке `.node`.)
- **SSH `matricarmz` — работает** (BatchMode да). Канал после вывода виснет:
  почти каждый вызов завершается клиентским таймаутом, хотя команда на проде
  отработала — вывод, успевший прийти, достоверен; «timed out» ≠ «не выполнено».
  Проверять состояние повторным чтением, не повтором мутации.
- **`&` в команде не проходит** (что-то в цепочке PowerShell→ssh фонит его):
  даже `echo "a&b"` виснет. URL с query-параметрами — через
  `curl -G --data-urlencode k=v`; `%{...}` в `-w` — только внутри одинарных
  кавычек (в двойных PowerShell раскрывает как формат).
- **PowerShell, не bash:** нет `grep/head/wc/cat/python3`; аналоги —
  `Select-String` / `Select-Object -First` / `Get-Content` / `python`.
- **`pnpm exec` не вкладывается:** `pnpm exec pnpm ...` падает; бинарь брать
  напрямую `.\node_modules\.bin\<имя>.CMD` с `workdir` пакета.
- **Сборка backend на боксе не идёт (OOM):** 1.5 ГБ RAM, `tsc` убит с exit 137
  (релиз 3.74.0). Прод раскатывается CI-артефактом `backend-dist` через
  `deploy-backend.sh` — руками на боксе не собирать.
- **Прод проверен 2026-10-12:** journald жив, но ничего не пишет после halt
  10.10 (см. сессию релиза 3.73.0) — чинить днём, не ночью.
