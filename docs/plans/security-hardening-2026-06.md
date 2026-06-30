# Security hardening plan — 2026-06

> Источник: исчерпывающий мультиагентный аудит безопасности (2026-06-25). Карта поверхностей + 11 специализированных ревьюеров + состязательная проверка каждой находки. **51 находка → 46 подтверждено** (0 опровергнуто; критичность скорректирована верификаторами). Сетевой контур добит вручную (5 verify-агентов упали на лимите сессии).
>
> Модель угроз: (a) низкоправный аутентифицированный пользователь, (b) атакующий в той же сети, (c) кража ноутбука (AppData), (d) MITM клиент↔сервер, (e) внешний неаутентифицированный по API, (f) инсайдер с доступом к БД/ФС VPS.

## Главный вывод

«Лёгкий доступ к базе» есть. Худшее — **«зайти с улицы → зарегистрироваться → скачать всю базу»** (C1, известная владельцу дыра, приоритет №1). Периметр при этом закрыт правильно: PostgreSQL и backend слушают только `127.0.0.1`, UFW default-DROP, настоящий Let's Encrypt-сертификат, клиент не отключает валидацию TLS. **Поэтому все дыры — на уровне аутентифицированного API / RBAC, чинятся точечно в backend-коде, без переезда инфраструктуры.**

## Что защищено хорошо (не трогаем)

- PostgreSQL 5432 + backend 3001/3002 → bind `127.0.0.1` (проверено `ss -tlnp` на проде). Снаружи недоступны.
- UFW активен, default DROP; наружу только 49412(SSH)/80/443 + торрент-порты 6969/51413.
- 443 — настоящий Let's Encrypt-серт; в клиенте нет `rejectUnauthorized:false`/`NODE_TLS_REJECT_UNAUTHORIZED` → MITM-через-самоподпись закрыт.
- Drizzle ORM параметризован — классического SQLi нет (дыры в *логике доступа*, не в инъекциях).
- JWT (не куки) → CORS-allow-all менее опасен; пароли хешируются; rate-limit на логине есть.

---

## Фазы исправления

### Фаза 0 — СЕГОДНЯ (горячее, прод живой) — **в работе**

| ID | Находка | Где | Статус |
|---|---|---|---|
| **C1** 🔴 | Публичная `/auth/register` → роль `pending` проваливается в catch-all и получает почти все права (incl. `sync.use`, `*.view`) → выгрузка всей БД через `/ledger/state/changes`. **Известная владельцу дыра, приоритет №1.** | `backend-api/src/auth/permissions.ts:11-37`, `routes/auth.ts:130-212`, `routes/ledger.ts` | **fix:** `pending → {}` (нет прав до одобрения админом) |
| **C2** 🔴 | Эскалация до суперадмина: оператор пишет свой `system_role` через `/ledger/tx/submit`. Гард `own_employee` проверяет *чью* строку, но не *какой атрибут*. | `services/sync/ledgerAuthzGuard.ts`, `shared/src/domain/ledgerAuthz.ts:52` | **fix:** универсальный backstop — server-only employee-атрибуты (`system_role`, `password_hash`, `access_enabled`, `login`, `delete_requested_*`) запрещены на клиентском sync-пути для всех ролей |

### Фаза 1 — эта неделя (массовый увод данных аутентифицированным пользователем)

Корень: чтение/выгрузка по принципу «всё минус PII-сотрудников», а не «только разрешённое ролью».

- **H1** — любой оператор/legacy-`user` тянет весь датасет (контракты/контрагенты/финансы); фильтруется только PII. `services/sync/pullReadFilter.ts`. *(table-level read-authz — отдельная нитка.)*
- **H2** ✅ — конструктор отчётов сливал все приватные чаты (ЛС). `chat_messages`/`chat_reads` → `ChatExport` (admin-only). PR #592.
- **H3** ✅ — конструктор отчётов сливал все приватные заметки. `notes`/`note_shares` → `AdminUsersManage`. PR #592.
- **H4** ✅ — конструктор отчётов выдавал EAV-PII (зарплата/паспорт/ИНН). Строки sensitive-атрибутов режутся для не-админов (`redactReportRows` + `isHiddenAttributeName`). PR #592.
- **H5** ✅ — `/ledger/state/query` обходил PII-фильтр операторов. Применён `makeOperatorReadFilter` как в соседних эндпойнтах. PR #592.
- **H6** — AI `execute_safe_sql` достаёт EAV-PII (фильтр режет имена колонок, не строки EAV). `services/ai/claudeTools.ts:352-389`. (AI на проде выключен.)
- **H7** — legacy-роль `user`/`pending` полностью обходит гард записи ledger. `services/sync/ledgerAuthzGuard.ts:34`. *(Частично нейтрализуется C1+C2: pending теряет `sync.use`, security-атрибуты закрыты backstop'ом; остаётся scoping остальных таблиц для legacy `user`.)*
- **H8** — приватный Ed25519-ключ подписи ledger закоммичен. `backend-api/ledger/server-key.json`. → ротация на проде + `git rm --cached` + чистка истории.

**Общий фикс H1–H6:** table-level read-authorization на pull/query/report-пути, scope из per-модульных `*.View` прав; приватные таблицы (`chat_messages`/`notes`/`note_shares`/`user_presence`) — только admin.

### Фаза 2 — клиент и доставка обновлений

- Локальный SQLite — незашифрованная полная копия → SQLCipher. `electron-app/src/main/database/db.ts`. **(остаётся)**
- ✅ E2E-ключ ledger — plaintext JSON → обёрнут `safeStorage` (`{enc,data}`, миграция legacy, громкий fail вместо тихой ротации, атомарная запись). `e2eKeyService.ts`. **PR #607.**
- ✅ Токены: fail-closed (in-memory вместо plaintext-fallback) при недоступном `safeStorage`. `authService.ts`. **PR #607.**
- ✅ Ночные бэкапы всей БД на клиенте plaintext → удаляются после просмотра (exit/switch) + sweep на старте, ограничено `backup_cache`. `backupService.ts`. **PR #607.**
- Updater: подпись метаданных офлайн-ключом (minisign) + Authenticode; всегда сверять SHA (`pending-update.json`/emergency/github-fallback не должны доверять size/локальному sha). **(остаётся)**

### Фаза 3 — упрочнение

- Неаутентифицированные каналы: `/client/*` heartbeat (спуфинг `lastUsername`), `/updates/peers` (отравление peer-list/раскрытие IP), `audit_log` (подделка через push), bootstrap-суперадмин (пароль с первого логина).
- Electron IPC-гейты: `e2e:keys:export` ✅ (#598), `chat:sendFile`/`files:upload` (произвольный путь) ✅ (#601), `will-navigate`/`setWindowOpenHandler` ✅ (#607), `MATRICA_CDP_PORT` инертен в prod-сборке ✅ (#607).
- Refresh-токены: ✅ отзыв при смене пароля / сбросе админом / отключении аккаунта — централизовано в `setEmployeeAuth` (`shouldRevokeRefreshTokensOnAuthChange`). PR #593.
- nginx: security-headers (HSTS/CSP/X-Frame-Options/X-Content-Type-Options), `MATRICA_CORS_ORIGINS` (убрать allow-all), `listen 18080` → bind 127.0.0.1 или убрать.
- Bulk-export: потолок объёма + троттлинг + запись факта экспорта в аудит. `routes/reports.ts:725-795`.
- Прочее: untrack `backend-api/ledger/blocks/*`; ReDoS на `/ledger/state/query` (re2/таймаут); enum-oracle `/auth/login-options`.

---

## Прогресс

- 2026-06-25: аудит проведён, план составлен.
- 2026-06-25: **Фаза 0 (C1+C2) смержена** (#591) в `main`. Деплой на прод отложен по решению владельца — дыры закроются при следующем релизе.
- 2026-06-25: **Фаза 1a (H2/H3/H4/H5) — увод данных через конструктор отчётов и `/ledger/state/query`** смержена (#592).
- 2026-06-25: **Фаза 1b — отзыв refresh-токенов при смене пароля/сбросе/отключении** (#593, медиум из Фазы 3, сделано раньше как дешёвое и автономное).
- 2026-06-25: **Фаза 3 — bounded-подмножество смержено** (#598). Каждую находку предварительно сверили с текущим кодом. В наборе:
  - **IPC-гейт `e2e:keys:export`/`:rotate`** — мастер-ключ ledger требует `admin.users.manage` (+ view-mode guard на ротацию); раньше любой renderer мог его утащить.
  - **`/ledger/blocks` → admin-only** — сырые блоки = plaintext-строки + пер-tx Ed25519-подпись, PII-редакция невозможна без слома подписи; клиентских потребителей нет (проверено electron+web-admin), операторы получают фильтрованное через `/state/changes`.
  - **`audit_log` через sync** — сервер штампует `actor` из аутентифицированной push-сессии (был подделываем под `superadmin`); зеркалит owner-атрибуцию прочих sync-таблиц.
  - **ReDoS `/ledger/state/query`** — лимит regex 200 симв. + отклонение `(a+)+`-паттернов; полноценный re2 отложен (нативная зависимость в релизном конвейере). +2 route-теста.
- 2026-06-26: **Фаза 3 — ранее отложенные 4 находки закрыты по решению владельца** («сделать по-настоящему, чтобы не сломалось»). Каждую спроектировали (мультиагентный design-проход), реализовали и сверили; #601 прошёл адверсариальное ревью (1 HIGH-регрессия найдена и исправлена до мержа), #602 — live CDP-verify (поймал и починил коллизию typeahead с глобальным input-assist).
  - **Auth на `/updates/peers`** (#600) — per-route `requireAuth`+`SyncUse` на 4 peer-эндпойнтах; клиент-апдейтер прокидывает токен сессии, до-логина graceful skip → central-server fallback (авто-апдейт + P2P + LAN сохранены). Download-путь остаётся публичным.
  - **IDOR файлов** (#601) — linkage-aware `canAccessFile` (`services/fileAccessService.ts`): владелец/админ/чат-участник/владелец+share заметки/engine-операция/EAV-по-типу/`directory_parts`. LIKE-prefilter + exact-id verify, actor-scoped SQL (после ревью), 30s-кэш. Шеринг и Yandex-хранение сохранены. Закрыт и write-IDOR на `POST /:id/preview`.
  - **Allowlist путей `chat:sendFile`/`files:upload`** (#601) — `pathOriginRegistry`: принимаются только пути, выданные main-процессом (диалог `files:pick` + `files:download`), TTL 30 мин. Все легитимные флоу (AttachmentsPanel/NotesPage/ChatPanel/note→chat) проверены.
  - **Enum-oracle `/auth/login-options`** (#602) — удалён; заменён на `/auth/login-suggest` (префикс ≥2, только `{login,fullName}`, cap 8, отдельный `suggestLimiter`) + machine-local recent (10 дней, с ФИО). Дропдаун «все пользователи» убран; логин не блокируется (всегда можно ввести вручную).
- 2026-06-26: **Фаза 2/3 — клиентский hardening-батч смержен** (#607). E2E-ключ под `safeStorage` + миграция/громкий-fail/атомарная запись; токены fail-closed (in-memory); чистка plaintext-бэкапов; nav/window-гарды (`will-navigate`/`setWindowOpenHandler`, печать сохранена); `MATRICA_CDP_PORT` инертен в packaged-сборке. Перед PR — адверсариальное ревью (5 измерений): поймало регресс печати (deny blank-попапов) + 3 robustness-бага — все исправлены. typecheck/lint/CI зелёные. **Рантайм CDP-смоук не прогонялся** — рекомендуется до тега релиза (правки трогают старт окна и логин). Едет со следующей сборкой клиента, на прод-сервер не деплоится.
- 2026-06-26: **H8 — ✅ ЗАКРЫТО.** При выполнении выяснилось, что утечка шире, чем «подписной ключ»: репо был **публичным**, в HEAD лежал `server-key.json` (прод подписывал им же — sha совпал), в **истории** — `data-key.json` + `state.json` (2026-01-27→2026-06-07, #252 убрал из трекинга, не из истории), 119 блоков с **552 `enc:v1:`** полями реальных ПДн (chat_messages/attribute_values сотрудников; data-key + шифротекст оба были публичны → расшифровываемы). Решение: live-ledger **вынесен из git-checkout** (`MATRICA_LEDGER_DIR=/home/valstan/matricarmz-ledger`, `mv` 341k блоков — root-cause); подписной ключ **ротирован** (старый retired, бэкап); data-key уже на не-утёкшем `k-mq3wacgz` (майская ротация); ledger untracked из HEAD (#614); **репозиторий сделан приватным** (forks/stars/watchers=0 → закрывает доступ к истории). Прод healthy, новый ключ активен. **Найденный капкан:** live-ledger трекался внутри checkout'а → наивный `git rm`/`reset --hard` удалил бы живые прод-данные; обязателен relocate+бэкап до любых git-операций (→ GOTCHAS). **Опционально/low:** полная вычистка истории `filter-repo`+force-push (1276 коммитов/579 тегов, реклон всех машин) — деприоритизировано (репо приватный + ключ ротирован).
- **Требует решения владельца:** H1 (крупный рефактор table-level read-authz всего pull, риск сломать sync).
