# Session Handoff

> Sticky-note для непрерывности разработки между сессиями и компьютерами. Перезаписывается целиком командой `/close_session`. История — через `git log -- docs/SESSION_HANDOFF.md`.
>
> Если работы в потоке нет — `Status: IDLE` и пустые секции. Команда `/start` это увидит и не будет ничего навязывать.

**Status:** IDLE (релиз **v2026.709.200** выпущен и раскатан на прод; активной нитки нет)
**Updated:** 2026-07-09 (Claude Opus 4.8, машина `rmz4val`)
**Branch:** `main` (= origin/main). Дерево чистое, stash пуст, открытых PR нет, локальная только `main`.
**Last released version:** **v2026.709.200 на проде** — `/health` = 2026.709.200, `/updates/status.latest` = 2026.709.200 (`lastError: null`, `infoHash` заполнен — потребовался 2-й рестарт), blockmap 200, оба сервиса active. Миграций не было (renderer-only).

## Текущая нитка

_n/a_ — сессия 2026-07-09 отгрузила **новый опциональный интерфейс «Трезубец» (v2)** релизом **v2026.709.200** (4 PR, все смержены):
- **#127** — каркас v2: 3 резиновые/сворачиваемые/переставляемые колонки (панель кнопок с dnd/pin/hide/overlay · списки · рабочая область), персист per-user; shell = обёртка существующей цепочки страниц, v1 не тронут.
- **#128** — вкладки открытых карточек (до 3, дедуп, кап, dirty-guard).
- **#129** — настоящий сплит «2 рядом» (две карточки одновременно, обе редактируемы; pane-aware close-backstop).
- **#130** — видимый тумблер v1/v2 в шапке рядом с темами.

Дефолт остаётся **v1** — на клиентах ничего не меняется, пока оператор сам не включит. Всё верифицировано CDP (split 18/18, cards 22/22, shell 26/26, тумблер 10/10, регрессия v1 12/12).

## Следующий шаг

**Активной нитки нет.** Ждём **спот-чек владельца на живом клиенте** после автообновления до v2026.709.200 (см. «Не забыть» §1). Дальше — по желанию из бэклога ([`PENDING_FOLLOWUPS.md`](PENDING_FOLLOWUPS.md)), сверено — не отгружено:
- 🟢 **V2 Фаза 4** (опц.): перестановка колонок drag'ом заголовков, session-restore открытых карточек, полировка тем, перф. + расширения сплита (3-я панель / MDI). PENDING §Планы/идеи.
- 🟢 **Фаза 3b прогноза** (после обкатки инкр.1): «основного мало, но не 0» + пулинг позиции + адаптив. План [`plans/engine-spec-forecast-phase3.md`](plans/engine-spec-forecast-phase3.md).
- 🟢 **Ещё тише клиент↔сервер (остаток):** консолидация ad-hoc таймеров на единый pulse + пауза локальных IPC-поллов.
- 🟢 **Backfill легаси `variantGroup`** спецификации в явные позиции.
- 🔴 **Решение владельца:** forward-proxy VPS для AI (Anthropic режет РФ-IP).

## Контекст

- Прод: **v2026.709.200**, оба сервиса active. Деплой: `git pull` (d82bac1d) → build серверных пакетов → 3 артефакта в `/opt/matricarmz/updates/` (`gh release download`, blockmap отдельным вызовом) → `release:ledger-publish 2026.709.200` → рестарт ×2 (первый оставил `stale_manifest`/`disk-fallback` + blockmap 404 — лаг in-memory torrent-сервиса; 2-й вылечил). Миграций нет. Обратимо (редеплой прежнего).
- Планы нитки: [`plans/ui-shell-v2.md`](plans/ui-shell-v2.md) (Фазы 1–3), [`plans/ui-shell-v2-split.md`](plans/ui-shell-v2-split.md) (сплит).
- Ключевые файлы: `shared/src/domain/uiShellV2.ts` (типы+sanitize+DEFAULT), `electron-app/src/renderer/src/ui/shellV2/` (V2Shell, ButtonPanel, v2ButtonCatalog, shellV2.css), `App.tsx` (`renderTabContent`, `renderSecondaryCard`, pane-aware close-flow, тумблер в шапке), `main/ipc/register/settings.ts` + `settingsStore.ts` (`UiShellPrefs` per-user блоб).
- Библиотеки (новые в electron-app): `react-resizable-panels@4` (API v4: `Group`/`Panel`/`Separator`, `Layout` = flexGrow-мапа, `onLayoutChanged`), `@dnd-kit/core`+`sortable`+`utilities`.
- Открытых PR: нет. Локальных веток с un-pushed коммитами: нет (все смержены+удалены).
- Верификация: драйверы в `.verifier-electron/` (gitignored) — `_smoke-v2-shell.mjs`, `_smoke-v2-cards.mjs`, `_smoke-v2-split.mjs`, `_smoke-topbar-toggle.mjs`. Хелпер `ensureShell` (идемпотентность межпрогонов).
- to-brain: письмо `2026-07-09-opt-in-alt-shell-without-forking-pages.md` (паттерн opt-in альт-оболочки без форка страниц; MAY/low).

## Открытые вопросы для пользователя

- Нет.

## Не забыть (low-priority)

1. **Спот-чек владельцем на живом клиенте** (после автообновления до v2026.709.200): кнопка «🧪 Новый интерфейс» в шапке → переключение v1↔v2; в v2 — перетаскивание/закрепление/скрытие кнопок, «поверх колонок», вкладки карточек, сплит «⑃» (две карточки рядом), сохранение раскладки между запусками. Собрать фидбэк перед снятием «беты». Живой UI гонялся через verifier-electron — базово ок.
2. **AV-ложнопозитивы watchdog'а** — поглядывать в «Критические события» (принятый риск unsigned-бинаря).
3. Ledger release-token — следующая ротация до ~2026-08-04 (PENDING ⏳); первый релиз после ~2026-08-01 упрётся, минтить новым.
4. Ротация SSH-ключей прода — до 2026-08-21 (PROJECT_STATE).
5. Мастера жмут «Выдать в работу» на ремнарядах, иначе прогноз по ремонту пуст (операционный, передать мастерам).
