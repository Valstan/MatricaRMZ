# H1 — Server-enforced read-authz на pull (table / entity-type level)

> **Статус:** A/B1a/B\* отгружены; **B2 SUPERSEDED (2026-07-02)** — владелец отверг матрицу §6, утвердил «доступ по разделам» → [`section-access-2026-07.md`](section-access-2026-07.md) (механика pull-фильтра и блокеры §12 переиспользуются там).
> **Решение владельца 2026-06-27:** «полный рефактор» → разбит на A (механика, 0 риска) и B (политика). Выбрано «A сейчас, потом B».
> **Связь:** расширяет [`security-hardening-2026-06.md`](security-hardening-2026-06.md) §H1; источник GO — brain `2026-06-25-security-h8-h1-override-go`.

## 11. Реализация A (отгружено — PR `feat/h1-read-authz`)

**Что вошло в A:** закрытие **privacy-gap** — `/state/snapshot` и `/state/query` теперь фильтруют приватные таблицы (`chat_messages`/`chat_reads`/`notes`/`note_shares`) per-user так же, как уже делал `/state/changes` (`pullChangesSince`). До этого cold-snapshot/ad-hoc query отдавали оператору **чужие** чаты/заметки. `user_presence` оставлен общим (online-индикатор, как и было).

- Новый единый источник правды [`syncPrivacy.ts`](../../backend-api/src/services/sync/syncPrivacy.ts): `PRIVACY_TABLES`, `privacyFilterForTable` (SQL), `getSharedNoteIds`/`getOwnedNoteIds`, `makePrivacyRowFilter` (row-level для snapshot/query). `pullChangesSince` переведён на него (verbatim-экстракция, без изменения поведения).
- Гейты зелёные: typecheck, lint, backend-suite 345/345; новый `syncPrivacy.test.ts`. Бэкенд-only — UI/shared/ledger не тронуты.

**Что СОЗНАТЕЛЬНО НЕ вошло в A → перенесено в B:**
- **Серверный энфорсмент бизнес `*.View` (механика-каркас).** Без целевой матрицы (§6) это **no-op на широкой матрице** = мёртвый непротестированный код. Строится вместе с B — там он реально что-то энфорсит и тестируется per-role. (Развилка для владельца: если хочешь каркас отдельным шагом сейчас — скажи.)
- **`audit_log` → admin-only.** Это **наблюдаемое сужение** (операторы теряют синк таблицы аудита), значит политика → B-матрица + verify, а не zero-risk A. _(Прим. §12: verify показал — потребителей нет, сужение безопасно.)_

## 12. B — доказательный анализ матрицы (workflow 2026-06-27, 36 агентов)

Прогон: картирование модулей (страница→entity-type/таблица/чувствительность) → синтез грида role×area → **состязательная проверка** каждого сужения на слом сценария роли. **Главный вывод: матрица B — НЕ «флип ячеек», она упирается в структурные ограничения RBAC+EAV.**

### Структурные ограничения (почему «в лоб» нельзя)
1. **Нет гранулярных прав.** Нет `contracts.view` (договоры/контрагенты гейтятся общим `masterdata.view`); нет per-report права (все отчёты под одним `reports.view`); нет field-level финансового права. Скрыть эти области единственным рычагом (коарс-перм) = сломать ядро ролей.
2. **Финансы вшиты в EAV-блобы.** Цена `unitPrice` лежит в том же `contract_sections` JSON, что и операционные номера ДС-секций, нужные двигателисту/технологу. Pull-фильтр гранулярен по `attribute_def`, в под-ключ JSON не умеет → нельзя срезать только цену, не унеся структуру.

### ✅ Безопасные сужения (реализуемо сейчас текущим механизмом, verify=none)
- **`audit_log` → admin-only на pull** — безопасно для ВСЕХ ролей. Живые экраны аудита (`SuperadminAuditPage`, `ChangesPage`) ходят в backend REST; единственный локальный потребитель `AuditPage.tsx` — мёртвый код. Push (запись в ledger) не трогаем.
- **HR-чувствительные поля сотрудника** (ДР/приём/увольнение/аккаунт) → расширить существующий PII-субфильтр (как salary/паспорт): резать для чужих, оставлять ФИО/должность/подразделение/**`employment_status`** (нужен supply для отсечения уволенных из выдачи инструмента). Карточка сотрудника штатно живёт с пустыми полями (null-гарды).
- **timekeeper (Табельщик)** — реально узкая роль: нужен только табель + сотрудники + цеха + опер-отчёты. Можно срезать склад/номенклатуру/BOM/снабжение/справочники/договоры/финансы. **НО только entity-type/table-level**, НЕ отзывом `masterdata.view` (он нужен табелю для lookup цехов).

### ⚠️ Требует предварительных рефакторов (НЕ «флип»)
Скрыть финансы/договоры от двигателиста/технолога/мастера требует НОВЫХ кодов прав (`contracts.view`, `reports.finance.view`, `work_orders.payroll.view`) + расщепления `contract_sections` (отделить `unitPrice`) + per-report категорийного гейта + фильтрации каталога отчётов. Существенный объём.

### 🔴 Важная поправка: viewer ≠ пассивный наблюдатель
`viewer (Наблюдатель)` — это **read-only роль БУХГАЛТЕРИИ/ПЭО** (логины glavbux/главбух, tatreal, gala, alvina, ur491). Их работа И ЕСТЬ финансы. **Скрывать финансы/договоры/payroll-отчёты от viewer — НЕЛЬЗЯ** (verify=blocking). Синтезатор предложил — состязательная проверка поймала.

### 🚧 Блокеры для ЛЮБОГО сужения (предусловия)
1. **legacy-роль `user`** обходит матрицу целиком (full-access; `operatorRolePermissions()`→null) → мигрировать все `user`-логины на конкретные роли + запретить назначать `user`, иначе сужения дырявы.
2. **Stale local cache** — forward-only sync не удалит уже синканные строки → нужен forced fullPull/wipe срезанных групп при понижении прав.
3. **Побочные каналы:** `warehouse:lookups:get` отдаёт полные списки контрагентов/договоров/сотрудников на склад-страницы; contract-алёрты (колокольчик) грузятся любому. Заткнуть при сужении соответствующих областей.

### Рекомендуемая разбивка B
- **B1 (безопасно) — ✅ ОТГРУЖЕНО (v2026.627.1151):** `audit_log` admin-only + HR-субфильтр + `password_hash` drop + клиентская зачистка хэшей. **timekeeper entity/table-narrowing СВЁРНУТ в B2** (решение владельца 2026-06-27): осмысленная часть (договоры/контрагенты у табельщика) — это EAV entity-type фильтр = ровно механизм B2; строить одноразово ради одной роли невыгодно (риск sync + тяжёлый verify). Per-role EAV-фильтр строим один раз в B2 под полную матрицу.
- **Предусловие B\*:** миграция legacy-`user` + механизм stale-cache wipe + затычка lookups/алёртов.
- **B2 (большой, по желанию):** финансовый/договорный контур для двигателиста/технолога/мастера — новые права + EAV-расщепление + per-report гейт. **viewer — финансы ОСТАВИТЬ.**

### B1a — отгружено (PR `feat/h1b-read-authz`)

Единый pull-чокпойнт `makePullReadFilter` на 3 поверхностях (`/state/snapshot|changes|query`):
- **🔴 Найдена и закрыта дыра:** `password_hash` сотрудников — EAV-атрибут, синкавшийся pull'ом **на все клиенты** (PII-фильтр его не трогал; аутентификация только серверная — клиент хэш не использует). Теперь режется **для всех ролей, включая админов**. _Зачистка уже утёкших копий:_ ✅ клиентская миграция (PR `feat/h1-purge-leaked-hashes`) — идемпотентный `DELETE` строк `password_hash` из локального SQLite в безусловном pre-sync шаге `migrateSqlite` (чистит существующие установки без re-sync, едет со следующим релизом клиента).
- **`audit_log` → admin-only на pull** (`isPullTableAllowedForRole`, skip fetch; push не трогаем).
- **HR-субфильтр операторам** (своё видно): только **`birth_date`, `hire_date`** (+ существующий PII salary/passport/inn/snils).

**Состязательное ревью (7 агентов) поймало 3 over-reach — исправлены до коммита:**
- `termination_date` **оставлен видимым** — это авторитетный сигнал «уволен» (`resolveEmploymentStatusCode`), ростер табельщика читает его по всем сотрудникам; срезка ⟶ уволенные показывались бы «работающими».
- PII/HR-субфильтр **только для operator-ролей** (как раньше) — legacy `user`/`pending`/`employee` не задеты (их кламп — отдельная миграция, не B1a).
- `system_role`/`access_enabled` **отложены** — их срезка ломает колонку «Доступ» на EmployeesPage (нужен парный renderer-фикс). Вместе с ними отложены `delete_requested_*`.

## 1. Проблема

Любой аутентифицированный оператор (и legacy-`user`) может вытянуть pull'ом **весь** датасет — договоры, контрагенты, движения с `counterparty_id`, цены услуг, наряды. Режется только чувствительный PII сотрудников (зарплата/паспорт/ИНН/СНИЛС, и только чужой). Read-authz отсутствует: сервер доверяет клиенту самоограничиться по UI-капам.

**Реальная серьёзность в нашем контуре** (≤12 доверенных сотрудников, backend/PG слушают только `127.0.0.1`, UFW default-DROP, настоящий серт, TLS-валидация не отключена) — **умеренная**: живой риск = объём, который может выкачать **скомпрометированный/обиженный аккаунт оператора** сверх того, что показывает ему UI. Аудит грейдил «High» исходя из недоверенного читателя.

## 2. Архитектура pull (разведано 2026-06-27)

**Три живых pull-поверхности, все за `requireAuth`:**

| Эндпойнт | Назначение | Текущая фильтрация |
|---|---|---|
| `GET /ledger/state/snapshot` ([ledger.ts:356](../../backend-api/src/routes/ledger.ts)) | cold pull, per-table | `makeOperatorReadFilter` (только PII). **Privacy чатов/заметок НЕ применяется** — gap |
| `GET /ledger/state/changes` ([ledger.ts:442](../../backend-api/src/routes/ledger.ts)) | incremental | `pullChangesSince` (SQL privacy чатов/заметок) → schema-validate → `makeOperatorReadFilter` (PII) |
| `GET /ledger/state/query` ([ledger.ts:167](../../backend-api/src/routes/ledger.ts)) | ad-hoc query | `makeOperatorReadFilter` (PII) |

- `POST /sync/push` и `GET /sync/pull` → **410 Gone** (мёртвый путь, [sync.ts](../../backend-api/src/routes/sync.ts)).
- `GET /ledger/blocks` → уже **admin-only** (Phase 3, сырые подписанные блоки нельзя редактировать без слома подписи).
- **Единый чокпойнт:** [`makeOperatorReadFilter`](../../backend-api/src/services/sync/pullReadFilter.ts) — применяется после каждой из 3 поверхностей. Сегодня: предвычисляет (cache 60s) set чувствительных employee `attribute_def_id` и режет такие `attribute_values`-строки, кроме своей. Расширяем именно его.

**Синк-таблицы (~18):** `entity_types`, `entities`, `attribute_defs`, `attribute_values`, `operations`, `audit_log`, `chat_messages`, `chat_reads`, `user_presence`, `notes`, `note_shares`, `erp_nomenclature`, `erp_engine_assembly_bom(+_lines/+_brand_links)`, `erp_engine_instances`, `erp_reg_stock_balance`, `erp_reg_stock_movements`.

## 3. Ключевой факт: модель EAV → authz по entity-type, не по таблице

Большинство бизнес-сущностей (employee, contract, counterparty, work_order, engine, part, service, supply_request, …) живут в **общих** `entities` + `attribute_values`, различаясь `entity_type_id`. Поэтому «table-level read-authz» из аудита на деле = **entity-type-level** на потоке `entities`/`attribute_values`, плюс настоящий table-level для выделенных ERP-таблиц.

- `entities`-строка несёт `type_id` → резолв в permission напрямую.
- `attribute_values`-строка несёт `attribute_def_id` → `def.entity_type_id` (уже так кэшируется для PII) → permission. Плюс существующий PII-субфильтр.
- Выделенные таблицы (`erp_*`, `operations`, `audit_log`) → permission по имени таблицы (all-or-nothing для роли).

## 4. Дизайн механизма

Обобщить `makeOperatorReadFilter` в role-aware read-authz предикат:

1. **Кэш (как сейчас, 60s):** `entity_type_code → id`; `attribute_def_id → entity_type_id`; set чувствительных employee-def (PII-субфильтр сохраняется).
2. **Статическая карта** `ENTITY_TYPE_VIEW_PERMISSION: entity_type_code → PermissionCode` и `TABLE_VIEW_PERMISSION: syncTable → PermissionCode` (наброски — §5). Privacy-таблицы (`chat_*`, `notes`, `note_shares`, `user_presence`) → admin/owner-only (закрывает gap snapshot).
3. **Предикат на строку:** определить entity-type/таблицу → требуемый permission → оставить ⟺ у роли есть это право (`operatorRolePermissions(role)` / admin-superadmin bypass) + сохранить PII-субфильтр для employee.
4. **Применить единообразно** на всех 3 поверхностях. `changes`/`query` уже зовут чокпойнт; в `snapshot` — добавить тот же предикат вместо «только PII» **и** privacy-гард таблиц.

Предикат — row-level (как сейчас), вписывается в существующий чокпойнт без переписывания SQL-путей. Низкий риск механики; риск — в политике (§6) и раскате (§7).

## 5. Наброски карты entity-type/таблица → право (детализируется при реализации)

| entity_type / таблица | Право (view) |
|---|---|
| `employee` | `employees.view` (+ PII-субфильтр) |
| `engine`, `engine_brand` | `engines.view` |
| `part`, `tool`, `product`, `nomenclature*` | `parts.view` / `erp.dictionary.view` |
| `contract`, `counterparty` | **спорно — см. §6** (сейчас все видят) |
| `work_order` | `work_orders.view` |
| `supply_request`, `service` | `supply_requests.view` |
| `erp_nomenclature`, `erp_engine_assembly_bom*` | `erp.cards.view` / `erp.dictionary.view` |
| `erp_reg_stock_balance`, `erp_reg_stock_movements` | `erp.registers.view` |
| `operations` | `operations.view` |
| `audit_log` | admin-only |
| `chat_*`, `notes`, `note_shares`, `user_presence` | privacy (admin или per-user, как в `pullChangesSince`) |

Точное соответствие code'ов берём из [`permissions.ts`](../../shared/src/domain/permissions.ts) (`PermissionCode`) и реальных `entity_types.code`.

## 6. Политика — целевая матрица *.View по ролям (НУЖЕН OK ВЛАДЕЛЬЦА)

**Самый важный пункт.** Механика (§4) сама по себе **ничего не ограничит сверх PII**, пока матрица широкая: у каждого операторского роля в базе ([permissions.ts:339 `OPERATOR_BASE_PERMISSIONS`](../../shared/src/domain/permissions.ts)) уже есть ~25 `*.View` (наряды, двигатели, `erp.*`, сотрудники, мастер-данные, отчёты). Реальный выигрыш конфиденциальности = **сузить per-role View-матрицу**: решить, какая роль НЕ должна видеть какую область.

Сейчас (фактически): **все операторы видят почти всё** (broad-view by design, RBAC #474; + явное прежнее решение владельца «договоры/контрагенты видимы для справки»).

**Решает владелец** (предложу грид на утверждение, например):
- Табельщик (`timekeeper`) → только табель + базовые карточки сотрудников; **без** договоров/финансов/нарядов?
- Наблюдатель (`viewer`) → что именно наблюдает?
- Двигателист/Мастер/Технолог/Снабжение → сохраняют свои операционные области; ограничить ли им суммы договоров / цены услуг?
- legacy-`user` → оставить full-bypass или мигрировать в роль?

Механика — за мной; **матрица — за владельцем** (это бизнес-конфиденциальность, не техника).

## 7. Раскат и риски

1. **Устаревший локальный кэш (M2b):** фильтр кусает только **свежие** pull'ы. Уже скачанные строки лежат в клиентском SQLite до forced fullPull. Решить: (a) forward-only (новый клиент/re-pull чисты, старый кэш дотлевает), либо (b) триггерить `client_settings` sync-request (fullPull) затронутым логинам — чистит кэш. Механизм есть (RBAC M2b хвост).
2. **Слом рабочих сценариев:** read-authz обязан **точно зеркалить** то, что реально потребляет UI роли — иначе пустые страницы / сломанный sync. Сверять по реальным зависимостям страниц + прогон `verifier-electron` под каждой ролью.
3. **legacy `user`** сейчас обходит фильтр (full) — решить судьбу (см. §6).
4. **`pending`** уже ограничен в `pullChangesSince` (privacy-таблицы skip).

## 8. Фазировка (де-риск — каждая фаза = свой PR под гейтами)

- **Фаза 0:** механика за флагом, матрица = текущая широкая (no-op по поведению) **+ закрыть privacy-gap snapshot** (chat/notes/presence). Отгрузить, верифицировать ноль изменений поведения.
- **Фаза 1:** включить предикат — сервер начинает энфорсить текущие `*.View` как есть (defense-in-depth: даже если UI прячет, сервер не отдаёт). Наблюдаемо всё ещё без изменений (матрица широкая). Прогон всех ролей: sync чист.
- **Фаза 2:** сузить матрицу по утверждённому гриду — роль за ролью, каждая со smoke `verifier-electron` + watch `server.authz.denied` в критсобытиях. Опционально forced fullPull.

## 9. Тест-план

- **Unit:** расширить [`pullReadFilter.test.ts`](../../backend-api/src/services/sync/pullReadFilter.test.ts) — роль × таблица/entity-type → visible/withheld; admin/superadmin неизменны; PII-субфильтр сохранён.
- **Integration / e2e (`verifier-electron`):** логин под каждой ролью → cold snapshot + incremental → ассерт какие таблицы/типы пришли/срезаны.
- **Regression:** chat/notes privacy теперь и на `/state/snapshot`; admin/superadmin полные; legacy-`user` по решению §6.

## 10. Открытые решения для владельца

1. **Утвердить целевую матрицу *.View по ролям** (§6) — собственно политика конфиденциальности.
2. **Устаревший кэш** (§7.1): forward-only vs forced fullPull.
3. **legacy `user`** (§6/§7.3): оставить full или мигрировать.

→ После OK по §10 — реализация по фазам §8 на этой ветке `feat/h1-read-authz`.
