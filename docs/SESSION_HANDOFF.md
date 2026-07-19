# Session Handoff

> Sticky-note для непрерывности разработки между сессиями и компьютерами. Перезаписывается целиком командой `/close_session`. История — через `git log -- docs/SESSION_HANDOFF.md`.
>
> Если работы в потоке нет — `Status: IDLE` и пустые секции. Команда `/start` это увидит и не будет ничего навязывать.

**Status:** ACTIVE
**Updated:** 2026-07-19 (Claude session, машина `PC40`)
**Branch:** `main` = `origin/main`.
**Last released version:** **v2026.719.146** (на проде). ⚠️ **В `main` лежат две неотгруженные фичи** (#270, #271) — релиза после них не было.

## Текущая нитка

Конструктор интерфейсов разворачивается в **рабочие read-only экраны** (решение владельца 2026-07-19: три направления A/B/C, пишущие low-code формы отклонены). План — [`plans/live-dashboard-constructor-2026-07.md`](plans/live-dashboard-constructor-2026-07.md).

- **Ф-A ✅** (#270): блок «Живой отчёт» на холсте (данные шаблона «Моих отчётов» в просмотре) + кнопки-переходы на вкладки + заготовка «Дашборд».
- **Заодно отгружено** (#271): рефактор настроек «Прогноза сборки» — 3 секции-аккордеона со сводками в заголовках + шаблоны настроек прогноза.
- **Открыто: Ф-B и Ф-C** (см. ниже).

## Следующий шаг

**Ф-B «Мои отчёты»** (первый шаг нитки; Ф-C — после неё либо параллельно, они не связаны):

1. Группировки с агрегатами — аддитивно `groupBy?: string` в `CustomReportSpecV1` ([`shared/src/domain/customReport.ts`](../shared/src/domain/customReport.ts), spec на строках ~75–86) + подытоги в чистой `applyCustomReportTransform` (~265–319, сейчас там только SUM числовых колонок) → рендер в [`CustomReportsPage.tsx`](../electron-app/src/renderer/src/ui/pages/CustomReportsPage.tsx), печать/CSV в [`customReportService.ts`](../electron-app/src/main/services/customReportService.ts).
2. Шаринг шаблонов между операторами — флаг «общий» у шаблона, общие в shared-scope бакете того же settingsStore-блоба (`SettingsKey.CustomReportTemplates`, прецедент `REPORT_USER_SCOPE_FALLBACK` в [`ipc/register/reports.ts`](../electron-app/src/main/ipc/register/reports.ts) ~306–352); писать/удалять общие — автор или админ, читать — все с `reports.view`.

Гейты как обычно: build shared → typecheck+lint → backend tests → CDP-смоук (стенд поднимается по профилю [`machines/PC40.md`](machines/PC40.md); готовые драйверы `.verifier-electron/_dashboard-smoke.mjs`, `_forecast-ux-smoke.mjs`, `_custom-reports-smoke.mjs`).

**Альтернатива по сигналу владельца:** выпустить релиз (`/reliz`) — в `main` уже ждут #270 и #271, операторы их пока не видят.

## Контекст

- План: [`docs/plans/live-dashboard-constructor-2026-07.md`](plans/live-dashboard-constructor-2026-07.md) (Ф-A закрыта, Ф-B/Ф-C расписаны).
- Связанные коммиты: `293badfd` (#271 настройки прогноза), `db7666bd` (#270 живой дашборд), `6ce18c21` (#269 бэклог standby-узла).
- Прод: v2026.719.146, не трогали в этой сессии.
- Открытых PR: нет. Локальных веток с un-pushed коммитами: нет. Stash пуст.
- В brain отправлено письмо [`mailbox/to-brain/2026-07-19-lowcode-readonly-composition.md`](../mailbox/to-brain/2026-07-19-lowcode-readonly-composition.md) (композиция read-only виджетов вместо пишущего low-code).

## Открытые вопросы для пользователя

- **Отзыв операторов** по v2026.718.1109 / v2026.719.146 (комплектование, сторно, оборотка, слепая инвентаризация) — от него зависят докрутки.
- **Распределённые серверы** (обсуждено 2026-07-19): решение = один тёплый standby-узел в LAN как Windows-служба, **не** Docker и не multi-master. Записано в PENDING, стройка — по сигналу владельца + выделенная машина.
- Планшет для цеха: Windows vs Android — решение не принято ([`plans/tablet-shop-floor.md`](plans/tablet-shop-floor.md)).
- AI/VPS — отложено владельцем, не поднимать.

## Не забыть (low-priority)

1. Ledger release-token — exp **2026-08-15**; ротация ≤ ~2026-08-12 (PENDING §Ротация).
2. Ротация SSH-ключей прода — до 2026-08-21.
3. Мастера жмут «Выдать в работу» на ремнарядах, иначе прогноз/комплектование по «выдано в сборку» неполны.
4. deadcode-прогон — ~2026-08-04.
5. Ф2 де-дуп `blank-synthetic-codes` — гейт красный (5 машин с застрявшим автообновлением), ждёт ручной переустановки клиентов владельцем; перепроверка ~2026-07-24.
6. Бэкап-таблицы на проде (`*_bak_20260717`, `*_bak_norms20260717`) — снести ~август после обкатки.
7. Флак `ledgerStore.concurrency.test.ts` под параллельной нагрузкой (изолированно зелёный) — если повторится, завести отдельным пунктом.
