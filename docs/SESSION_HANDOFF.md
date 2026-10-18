# Session Handoff

> Sticky-note для непрерывности: куда шла нитка, что дальше. История — в `git log`, открытое — в `docs/PENDING_FOLLOWUPS.md`, сделанное — в `docs/COMPLETED.md`. Только активное: старые нитки вычищены (правило раскола «открытое vs сделанное»).

**Status:** IDLE — нитка «Видимость GPU на клиентах» закрыта (#1372 слит, тема GPU закрыта владельцем); выкат — ближайшим релизом.
**Updated:** 2026-10-18 (opencode session, машина `PC79`)
**Branch:** `main` — всё слито, дерево чистое
**Last released version:** **v3.79.0** на проде (+ android-v3.79.0).
**В релизе ещё нет:** диагностика GPU (#1372) — выкатить ближайшим релизом.

## Хвосты (не потерять)

- **Показать кладовщику** фазу 2 «Кладовщика» (в проде с v3.79.0): нормы с сезоном, отпуска, группы, коллективная выдача, импорт ЗУП. Первый живой импорт — по записи в `PENDING_FOLLOWUPS`.
- **Фаза 3 «Кладовщика» — только по воротам 2→3** (месяц живых выдач); база — `docs/plans/_archive/ppe-kladovshik-phase2.md` §12.
- **Почта brain** — по слову владельца: `2026-10-12-local-postgres-for-smoke` (строка-указатель про локальный PG в `AGENTS.md`) и `2026-10-13-sidecar-pooled-368` (ack по #368 не отправлен).

## Контекст (стенд, ABI, замеры)

- Замер кадров GPU vs программный рендеринг: рецепт и цифры — `docs/machines/PC79.md`, §«Замер кадров»; драйвер `.verifier-electron/cdp-frame-timing.mjs` (gitignored). Вывод: разницы нет, кадр упирается в main-поток.
- ABI-танец стенда: Electron ABI 148 ↔ Node ABI 137. **`abi-node-backup` обновлять только после dlopen-проверки под node** — иначе туда уедет Electron-ABI (поймано 18.10 на `better-sqlite3-multiple-ciphers`).
- `dev:seed-nomenclature-verify` пишет в PG напрямую, без журнала → клиент этих строк не видит, пока не прогнать `sync:restamp:apply -- --tables erp_nomenclature`.
- Гейты: `-r typecheck`, `-r lint` — зелёные; `-r test` — shared 97, android 14, backend-api 141, electron-app 212 (+2 skip), `TEST_EXIT=0`. Код возврата брать из прямого запуска: через `Tee-Object | Select-Object` однажды дал `1` при зелёных сводках.

## Не забыть (low-priority)

- Пересадить 3 живых legacy-`user` на роль «Кладовщик» — парк уже ≥ v3.15.0, окно владельца (запись в `PENDING_FOLLOWUPS`, §⏳).
- `clientOpsArchive.test.ts` («архив с UTF-8») на PC79: в пакете красный (7za висит), одиночно зелёный — перегруз; CI на Linux зелёный. Записано в `docs/machines/PC79.md`.
- Воркауты OpenCode сняты (все четыре); работа из них сохранена ветками — чужие незапушенные: `sarafan` `wip/task2b-docs` (1 коммит), `brain_matrica` `docs/pc79-wsl-removal-d131` (2 коммита). Пуш — дело сессий тех проектов; из MatricaRMZ чужое не пушим.
