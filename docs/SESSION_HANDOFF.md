# Session Handoff

> Sticky-note для непрерывности разработки между сессиями и компьютерами. Перезаписывается целиком командой `/close_session`. История — через `git log -- docs/SESSION_HANDOFF.md`.
>
> Если работы в потоке нет — `Status: IDLE` и пустые секции. Команда `/start` это увидит и не будет ничего навязывать.

**Status:** ACTIVE (нитка Ф2 де-дупа ждёт раската клиентов — apply отложен решением владельца 2026-07-12)
**Updated:** 2026-07-12 (Claude Fable 5, машина `rmz4val`)
**Branch:** `main` (= origin/main, `e859610e`). Дерево чистое, stash пуст, открытых PR нет, локальная только `main`.
**Last released version:** **v2026.712.1818 на проде** (новый релиз в этой сессии НЕ выпускался — все изменения серверные скрипты/тесты/доки, на прод доехали `git pull`).

## Текущая нитка

**Ф2 де-дупа, финальный шаг `blank-synthetic-codes`** — заблокирован гейтом раската. Сессия 2026-07-12 (вечер) закрыла 3 нитки бэклога (#185–#190):
- **H7 шаг (а)** ✅ — `security:role-report`; прод: живых legacy-`user` всего **4** (novosel, radik, kostroma, zamkomdir), неизвестных ролей 0.
- **Integration-тест Workshop-наряда** ✅ — #186, 8 кейсов, сьют 400/400.
- **Backfill 3 сирот** ✅ на проде — 2 созданы, «Гильза» усыновлена (`warehouse:link-nomenclature-to-part`, #187–#189); сирот 0. Пойманы грабли **M31** (recordSyncChanges для ERP = PG-no-op) и повтор **M30** (unsourced env → паразитный ledger; вычищено, переподписано).

## Следующий шаг

**Проверить раскат и прогнать blank-synthetic-codes** (владелец дал добро «делать как только раскатано», 2026-07-12):
1. Гейт: `ssh matricarmz` → `sudo -u postgres psql matricarmz -c "select coalesce(nullif(last_version,''),'(нет)') as v, count(*) from client_settings where last_seen_at > (extract(epoch from now()-interval '7 days')*1000) group by 1 order by 1 desc;"` — все недавние клиенты должны быть **≥ 2026.712.1818** (на 2026-07-12 вечером — 0 таких, завод на выходных; ожидание — пн-вт 14-15 июля).
2. Бэкап: `pg_dump "$DATABASE_URL" -t erp_nomenclature -t directory_parts -f ~/backup-blank-synthetic-$(date +%Y%m%d).sql`.
3. **⚠️ M30 — env обязателен:** `cd MatricaRMZ && set -a; . /etc/matricarmz/matricarmz.env; set +a; corepack pnpm -F @matricarmz/backend-api warehouse:blank-synthetic-codes` (dry) → `:apply` (123 DET- + 22 NM- → пусто, retire 2 духов). Подтверждение владельца на apply — в тот же ход (уже принципиально дано, но прод-мутация — переспросить коротко).
4. Верификация: M31-паттерн — перечитать PG; сирот/синтетики 0; спот-чек клиента после sync.

## Контекст

- План: [`plans/parts-nomenclature-deep-dedup-2026-07.md`](plans/parts-nomenclature-deep-dedup-2026-07.md) §Ф2 (это последний шаг), зеркало в [`PENDING_FOLLOWUPS.md`](PENDING_FOLLOWUPS.md) §Техдолг.
- Коммиты сессии: #185 (H7 report) · #186 (integration-тест) · #187/#188/#189 (link-скрипт: создан → канонический upsert → метрика ref-bridge) · #190 (доки: PENDING/COMPLETED/GOTCHAS M31).
- Прод: v2026.712.1818, оба сервиса active; прод-мутации 2026-07-12 (бэкап `~/backup-orphan-backfill-20260712.sql`): 2 зеркала созданы, «Гильза» dc2554af усыновлена (kind=part, ref=fa096ecf, имя «Гильза стальная»), 2 паразитные строки `ledger_tx_index` удалены, 3 строки переподписаны под боевым env.
- Открытых PR: нет. Un-pushed веток: нет.
- Побочный хвост: на проде снова существует паразитный каталог `~/MatricaRMZ/backend-api/ledger` (пересоздан unsourced-прогонами; см. M30) — можно удалить при случае (не срочно, вреда при сорсинге env нет).

## Открытые вопросы для пользователя

- **H7 шаг (б):** кому какие роли — 4 живых legacy-`user`: novosel (Новоселов С.Н.), radik, kostroma (Костюнин Р.А.), zamkomdir (Щербик В.Л.). После пересадки — флип (в) fail-closed (1 строка).
- **UI-конструктор** — 3 вопроса из [`plans/ui-builder-modules.md`](plans/ui-builder-modules.md) §Открытые вопросы (владелец: «в следующей сессии»).
- **AI/VPS** — отложено владельцем на неопределённый срок (2026-07-12); PENDING 🔴 остаётся как есть, не поднимать.
- **Watchdog `CleanupMatricaFiles`** — no-op или перенацелить (PENDING §Watchdog, висит).

## Не забыть (low-priority)

1. **Ф2 гейт** — не гнать apply, пока не все недавние клиенты ≥ 2026.712.1818; env сорсить (M30); после apply — M31-верификация PG.
2. `docs/plans/owner-batch-2026-06-19.md` — заархивировать (5/6 отгружено).
3. AV-ложнопозитивы watchdog'а — поглядывать в «Критические события».
4. Ledger release-token — ротация до ~2026-08-04.
5. Ротация SSH-ключей прода — до 2026-08-21.
6. Мастера жмут «Выдать в работу» на ремнарядах.
7. deadcode-прогон (месячная дельта) — ~2026-08-04.
