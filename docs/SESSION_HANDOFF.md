# Session Handoff

> Sticky-note для непрерывности: куда шла нитка, что дальше. История — в `git log`, открытое — в `docs/PENDING_FOLLOWUPS.md`, сделанное — в `docs/COMPLETED.md`. Только активное: старые нитки вычищены (правило раскола «открытое vs сделанное»).

**Status:** ACTIVE — релиз 3.89.0 в подготовке: локальный движок Ииваныча снят с клиентов, вся работа через прод-сервер (`AI_SERVER_ENGINE_*`, `opencode` на `127.0.0.1:49374`). Трек 1 и модуль «Заказ-наряд» остаются на потом. Смоук не гонялся — `better-sqlite3` под другим ABI; гейты (`lint` + `typecheck` + `prodOnlyAiChat.guard`) зелёные, случайный `engineStrictView`-тайм-аут — флаки на этой машине.
**Updated:** 2026-10-23 (решение владельца 23.10 — только сервер, машина `COMPUTER`)
**Branch:** `feat/prod-only-iivanych-3.89.0` (после мержа — `main`)
**Last released version:** **v3.88.0** на проде (+ android-v3.88.0).

## Текущая нитка

**Ииваныч — только с прод-сервера (релиз 3.89.0).** Решение владельца 23.10.2026: локальный движок снят целиком — нет бинаря, каталога, настроек `ai.engineMode`, кнопок в интерфейсе. Код (`electron-app/src/main/services/prodOnlyAiChat.guard.test.ts`) и документы (`docs/plans/prod-only-iivanych-2026-10.md`) фиксируют договорённость: вопрос = `pending`, уходит синком, ответ приезжает pull'ом. `opencodeTracesCleanup` при старте гасит живой процесс и чистит остатки (`%LOCALAPPDATA%\...\engine`, `<userData>\engine`, `%TEMP%`); деинсталлятор тоже сносит каталог.

## Следующий шаг

1. **Завершить релиз 3.89.0** (`/reliz`): версия, `releaseWelcome` (только `highlights` + `epigraph`), тег `v3.89.0` + `android-v3.89.0`, PR, мердж, выклад артефактов (`.exe`, `.blockmap`, `latest.yml`) в `/opt/matricarmz/updates/`, APK в `updates/android/`, `db:migrate`, `release:ledger-publish`, рестарт сервисов (`:3001` / `:3002` отдельно), проверка `/updates/status` и баланс DeepSeek.
2. **Проверить баланс DeepSeek** на проде (на 21.10 было 0 / 402) — иначе при паузе движка оператор не получит ответа вообще (последствия записаны в `docs/plans/prod-only-iivanych-2026-10.md` §«Последствия»).
3. **Модуль «Заказ-наряд»** — PR-2 (передача обеими сторонами), затем PR B трека 1 (`MOVE` вкладок).
4. **Старые APK** в `<updatesDir>/android/` — снести (не отдаются планшетам, занимают ~434 МБ).

## Контекст

- Файлы релиза: `VERSION`, `shared/src/domain/releaseWelcome.ts`, `docs/COMPLETED.md`, `docs/plans/prod-only-iivanych-2026-10.md` (заменил `neural-auto-engine-2026-10.md`, тот помечен superseded), `docs/CODEBASE_MAP.md` (AI-строка), `docs/PENDING_FOLLOWUPS.md` (LAN-зеркало снято, DeepSeek-баланс — открыто).
- Гейт `prodOnlyAiChat.guard.test.ts` читает исходники подстроками — не переименовывать строки, которые он проверяет (`pending`, `runLocalAiChatAnswer`, `resolveAiEngineMode`), иначе сторож сломается молча.
- Прежний план `neural-auto-engine-2026-10.md` в архив не унесён — пусть живёт помеченным `superseded`.

## Что не сработало / осталось

- `corepack pnpm -r test`: 222 passed, 2 failed — `prodOnlyAiChat.guard.test.ts` (путь исправлен, теперь зелёный) и `engineStrictView.test.ts` (тайм-аут 5 с, флаки на этой машине, не регресс). Перезапуск одиночно — зелёный; при релизе это не блок.
- Живой CDP e2e-смоук окна Ииваныча не гонялся (нет живого Electron на этом сеансе); в теле PR указать «смоук не гонялся, проверено через `guard` + `lint` + `typecheck`».
- Прод-проба `opencode-web.service` активна, `AI_SERVER_ENGINE_ENABLED` в `/etc/matricarmz/matricarmz.env` (1 вхождение), `/updates/status` и `:3001`/`:3002` health — проверить в ходе деплоя (ssh-тайм-ауты на проде при проверке не влияют на выклад).
