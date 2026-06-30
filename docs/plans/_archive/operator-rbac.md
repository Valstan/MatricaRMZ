# План: RBAC операторов — ролевые ограничения доступа

> Источник: директива brain `2026-06-18-operator-role-based-access-control` (kind=directive, recommend, normal). Заявка владельца: операторы правят там, где работают; в остальном — просмотр. Ключевая сложность: запрет на модуль B не должен ломать работу в модуле A (каскадные записи). Архитектура brain (#015): гейтить по **операциям/сценариям** на **серверном** слое, не по таблицам и не в UI; deny-лог как эмпирическая петля.
>
> **Статус: РЕШЕНИЯ ВЛАДЕЛЬЦА ПОЛУЧЕНЫ 2026-06-21 → план реализации.** Модель: **уровни + рабочие роли** (две оси). Объём: **всё вместе** — роли-пресеты + дозакрытие гейтинга + deny-лог + очередь одобрения изменений пользователей. Запрет на «чужие документы» (владелец-документа) — **не делаем** (внутри участка правят сообща). Остался один вход от владельца: **логин начальника отдела кадров** (на него вешается право одобрять кадровые заявки).

## 1. Что уже есть (хорошая новость — инфраструктура готова)

- **86 permission-кодов**, уже **операционных** (не табличных): `engines.edit`, `work_orders.close`, `supply_requests.sign/director_approve/accept/fulfill`, `parts.create/edit/delete`, `timesheet.edit`, … — `shared/src/domain/permissions.ts`.
- **Роли** (`system_role` EAV-атрибут): `superadmin` (всё), `admin` (всё кроме 10 admin-only), `user` (**всё кроме admin-only — т.е. сейчас любой оператор правит почти всё** ← вот это и есть проблема), `pending`, `employee` (ноль доступа). `backend-api/src/services/employeeAuthService.ts:249`, `backend-api/src/auth/permissions.ts:11`.
- **Серверный гейт** `requirePermission(code)` — `backend-api/src/auth/middleware.ts:38`. Но покрытие **разреженное (19/31 route-файлов)** — часть write-эндпоинтов не гейтится → ограничение «протечёт».
- **Per-user overrides** (`user_permissions` grant/revoke) + **time-bound делегирования** (`permission_delegations`) — `schema.ts:294/315`. Механизм точечной настройки уже есть.
- **UI-капы** (`deriveUiCaps`) скрывают/блокируют кнопки по правам — `electron-app/src/renderer/src/ui/auth/permissions.ts`. Это удобство, НЕ защита (защита — на сервере).
- **Deny-лог отсутствует** — 403 не пишется системно (только эвристика «forbidden» в criticalEvents). Это нужно добавить (петля корректировки).

**Вывод:** ядро RBAC построено и операционно. Нужно: (а) задать **роли-пресеты** уже операторов; (б) **дозакрыть гейтинг** на write-эндпоинтах; (в) **deny-лог**; (г) назначить роли и итерировать.

## 2. Анализ: кто чем реально пользуется (прод, audit за 2025-12-23…2026-06-18, 22 актора)

Источник: `statistics_audit_events` (поле `action` = операция). Только записи (create/update/delete):

| Логин | ФИО | Что реально делает (операции) | Профиль |
|---|---|---|---|
| `mubvera` | Мубаракшина Вера Н. | engine.create ×137 | **Двигателист** |
| `ozerolove` | Озернова Любовь В. | engine.create ×86 | **Двигателист** |
| `nastya_spec` | Воронцова Анастасия Ю. | engine.create ×75 | **Двигателист** |
| `alina_goz` | Кривошеева Алина А. | engine.create ×2 | Двигателист (редко) |
| `fatyhova` | Фатыхова Наталья Н. | partBrandLink.upsert ×375, part.update_attribute ×46, part.create ×15, partBrandLink.delete ×34, partTemplate, engine.create ×12 | **Технолог/номенклатура** |
| `olgavolk` | Волкова Ольга | partBrandLink ×29, part.update_attribute ×17, part.create, engine.create | **Технолог/номенклатура** |
| `nastya_tech` | Хайруллина Анастасия А. | part.update_attribute ×12, part.create ×6, part.delete ×3, engine.create ×5, supply_request.create/transition ×5 | **Технолог + Заявки** |
| `technolog_n` | (нет в daily) | part.update_attribute ×12, part.create, part.delete, engine.create | **Технолог** |
| `ramzia` | Валиева Рамзия Р. | work_order.create ×36, work_order.delete ×21, part.create | **Мастер/наряды** |
| `peo_irina` | Сырцова Ирина Д. | supply_request ×2 | Снабжение/ПЭО |
| `glavbux` | Купцова Наталья А. (гл.бух) | — (онлайн, без записей) | **Просмотр** |
| `tatreal` | Брюхачева Татьяна Н. (бухг.) | — | **Просмотр** |
| `gala`, `alvina`, `ur491`, `peo_kt` | Кокшарова Г., Гомаюнова А., Голубева Л., Кутровская Т. | — / редко | **Просмотр** |
| `valstan` | Савиных Валентин В. | всё | **Админ** |
| `superadmin` | — | всё | **Админ** |

**Наблюдения, критичные для дизайна:**
1. **Чёткая специализация** — большинство пишет ровно в 1 модуль. Заявка владельца реалистична.
2. **`engine.create` делают многие** (технологи 12/5/3, не только двигателисты) — НЕ делать engine эксклюзивом двигателистов, иначе сломаем технологам импорт. Роли должны включать **каскадные зависимости** (создание детали/двигателя как часть основной работы).
3. **Никто из операторов не правит контракты/контрагентов/ЛД/зарплату** в окне — значит запрет на эти модули для операторов ничего не сломает (ровно пример владельца «не контракты и не ЛД»).

## 3. Подтверждённая модель ролей (владелец, 2026-06-21)

**Две оси:** *уровень* (сколько власти) × *участок* (где edit). Один линейный ранг не годится — два оператора одного уровня (двигателист/снабженец) нуждаются в разных edit-участках. View — широкий по умолчанию; edit — только в своём участке. Запрета на «чужие документы» внутри участка нет (решение владельца — правят сообща).

**Уровни** (есть в коде):
| Уровень | Доступ | role-ключ |
|---|---|---|
| Суперадмин | всё + одобрение кадровых заявок | `superadmin` |
| Администратор | всё операционное + управление пользователями | `admin` |
| Оператор | view везде + edit своего участка ↓ | новые role-ключи ↓ |
| Нет доступа | ноль | `employee` |
| На согласовании | ноль до назначения роли | `pending` |

**Рабочие роли оператора** (база = view-all + reports + sync/updates/chat + print; сверху — edit-участок):
| Роль | role-ключ | Edit-коды | Кандидаты (аудит) |
|---|---|---|---|
| Двигателист | `engineer` | engines.edit, engines.disassemble_confirm, operations.edit, defect_act.edit/print, files.upload | mubvera, ozerolove, nastya_spec, alina_goz |
| Технолог | `technolog` | parts.create/edit/delete, parts.files.*, masterdata.edit, engines.edit (каскад), files.upload | fatyhova, olgavolk, technolog_n |
| Мастер | `master` | work_orders.create/edit/close/revert/print, warehouse.assembly_return, **услуги** (см. ⚠️ ниже) | ramzia |
| Снабжение/ПЭО | `supply` | supply_requests.create/edit/print + sign/director_approve/accept/fulfill (по человеку — overrides) | peo_irina, peo_kt |
| Табельщик | `timekeeper` | timesheet.edit/print | по назначению |
| Наблюдатель | `viewer` | — (только база) | glavbux, tatreal, gala, alvina, ur491 |

- **Комбо** (`nastya_tech` = технолог+заявки) — поверх роли через существующие `user_permissions` overrides, не отдельной ролью.
- **Чувствительное = только админ** (не операторам): `admin.users.manage`, `clients.manage`, контракты/контрагенты, ЛД сотрудников/зарплата/подписи, шаблоны цехов/нарядов, `movements.revert`, `warehouse_locations.manage` — уже admin-only в `defaultPermissionsForRole`.
- ⚠️ **Услуги:** нет отдельного кода `services.edit` — править услуги Мастеру, не открывая ему все справочники (`masterdata.edit` слишком широк). На реализации: либо ввести узкий `ServicesEdit`, либо проверить, под каким гейтом сейчас write услуг (`servicePricing.ts` / generic masterdata-роут).

## 4. Находки в коде, меняющие объём (разведка 2026-06-21)

**Очередь одобрения изменений пользователей — уже наполовину есть, строить с нуля не надо:**
- **`change_requests`** (`schema.ts:145`) — generic maker-checker: `status` (pending/applied/rejected), `table_name`/`row_id`, `before_json`/`after_json`, `change_author_*`, `decided_by_*`, `note`. Модуль «Изменения» (`routes/changes.ts`, `ChangesPage.tsx`, `canDecide`, право `updates.use`) — UI одобрения.
- **Удаление пользователя уже идёт через заявку:** `adminUsers.ts` `/users/:id/delete` от не-суперадмина → `requestUserDelete`; суперадмин → `confirmUserDelete`; есть `/delete-request`, `/delete-confirm`, `/delete-cancel`, `/users/pending/approve`.
- **Вывод:** Этап 2 = **расширить** существующий механизм на add/edit (не только delete) + добавить одобряющего **«начальник ОК»** рядом с суперадмином + UX-сообщение submitter'у. Не новый подузел.

## 5. План реализации (всё вместе; внутренне — проверяемые вехи)

**M1 — Роли-пресеты (ядро).** Заменить плоский `defaultPermissionsForRole` (`backend-api/src/auth/permissions.ts:11`) на per-role пресеты из §3. Новые role-ключи; `superadmin/admin/employee/pending` без изменений. **Миграция безопасно-аддитивна:** старый `user` оставить = текущее поведение до явного перевода логина → нет окна, когда оператор не может работать. Назначение ролей реальным логинам — в том же релизе. Combos — overrides.

**M2 — Дозакрыть серверный гейтинг.** Пройти write-эндпоинты без `requirePermission` (~12/31 файлов) и навесить код операции (brain #015 — защита только на сервере). Решить гейт услуг (⚠️ §3). UI-капы (`deriveUiCaps`) — синхронизировать (удобство, не защита).

**M3 — deny-лог (петля).** На 403 в `requirePermission` (`auth/middleware.ts`) писать `{actor login+ФИО (clientLabel.ts), permCode, endpoint, ts}`. Эмпирическая корректировка ролей «по ходу пьесы».

**M4 — Очередь одобрения изменений пользователей** (на базе `change_requests`, расширение):
- Роутить user add/edit/delete через заявку для не-привилегированных (delete уже частично). 
- Новый одобряющий: право `employees.approve` (или роль-флаг) — на логин начальника ОК; decider = суперадмин **или** держатель `employees.approve`.
- UX submitter'а: *«Правки отправлены начальнику отдела кадров и суперадминистратору. Ждите одобрения. Для ускорения — позвоните им.»*
- Заявки видны одобряющему в «Изменения» (или отдельной панели) → approve применяет, reject отклоняет с причиной.

**M5 — Verify + раскат + итерация.** CDP: для каждой роли типовые операции проходят, чужие write → 403, каскады (close наряда → склад; дефектовка → утиль) не падают. Назначить роли логинам. **Перед закрытием доступов — прислать brain карту логин→роль в `to-brain`** (директива #474 просит сверку до Ф2). ~2 недели смотреть deny-лог → донастроить.

## 6. Риски
- **Каскадные записи** (главный риск владельца): close work_order → склад/двигатель; дефектовка → утиль; создание детали → entity+mirror. Роль включает **все операции сценария**. Deny-лог ловит пропуски (M3 обязателен).
- **Разреженный гейтинг:** без M2 ограничение «протекает». M1+M2 идут вместе.
- **UI-кэш прав:** права кэшируются на клиенте до refresh — смена роли видна после перелогина. Учесть в раскате.
- **Миграционное окно:** не переводить операторов на `viewer` «по умолчанию» (сломает работу) — аддитивно, перевод per-login в релизе.

## 7. Финализированная политика ledger-гейта (владелец, 2026-06-21)

**Разведка переопределила M2.** REST-эндпоинты уже гейтятся ~99% (плановое «12 файлов» устарело). Но основные сущности пишутся через `/ledger/tx/submit` → `applyLedgerTxs` → `writeSyncChanges`, который проверяет **только авторизацию** (`if (!user) 401`), без per-операционных прав. Гранулярные коды (`EnginesEdit`/`PartsCreate`/…) — **UI-only флаги** (`deriveUiCaps`), на сервере не проверяются нигде (подтверждено: `EnginesEdit`/`PartsEdit`/`MasterDataEdit`/`SupplyRequests*`/`WorkOrdersEdit` не используются как гейт). Это дыра brain #015.

**Решение владельца: полный ledger-гейт (brain #015).** Карта прав в `applyLedgerTxs`, чужие tx → `skipped` с причиной `forbidden:<тип>` (не валим батч, offline-очередь не травится; кормит deny-лог M3).

**Гейт по ТИПУ, не по таблице** (почти всё — EAV `entities`+`attribute_values`, различие — `entity_type`; заявки/наряды — `operations` по `operation_type`). Внутренние каскады правки карточки проходят сами (все `attribute_values` сущности → один тип → одно право).

### Карта (entity_type / operation_type → право)
| Тип | Право | Кто |
|---|---|---|
| `engine`, `engine_node` | EnginesEdit | Двигателист (+ Технолог каскадом) |
| `part`, `part_template`, `part_engine_brand`, `nomenclature` | PartsEdit | Технолог |
| `engine_brand`, `product`, `category`, `unit`, `tool*` | MasterDataEdit | Технолог |
| `service` | **ServicesEdit** (новый код) | Мастер |
| `work_order` | WorkOrdersEdit | Мастер |
| operations: engine-flow (acceptance/kitting/defect/repair/completeness/test/disassembly/otk/packaging/workshop_transfer/shipment/customer_delivery) + stock/tool движения | OperationsEdit | **Двигателист И Мастер** (п.1: «вносит всё один оператор» — не дроблю) |
| operation `supply_request` | SupplyRequestsEdit | Снабжение |
| 🔴 `contract`, `customer` | только admin/superadmin | операторам недоступно |
| 🔴 `employee` (+ зарплата/ЛД в attribute_values) | **own-only**: оператор правит/видит только СВОЮ карточку; admin — все | п.3 |
| 🔒 структурные: `workshop`, `section`, `department`, `store`, `link_field_rule` | **только superadmin** | п.2 |
| `notes`, `chat_*`, `user_presence`, `audit_log` | по владельцу (как сейчас) | любой авторизованный |

### Миграционная безопасность
Гейт бьёт **только по новым операторским ролям**. `user`(legacy)/`admin`/`superadmin` проходят всё → никто не ломается до поимённого назначения роли. Идеально для поэтапного раската.

### Части M2
- **M2a — write-гейт (ledger):** пакетный резолв типа per-tx + проверка прав + `skipped:forbidden`. Ядро.
- **M2b — read-ограничение (pull):** «оператор видит только своё» по чувствительному (`employee`/зарплата чужих, `contract`/`customer`) — это **другой путь (sync-pull фильтр)**, отдельная под-веха.
- **M1-реалайн:** пресеты в shared подровнять под коды карты (+ новый `ServicesEdit`); PR #525 ещё не смержён.

### Один домысел на подтверждение
П.1 «операции — один оператор»: трактую как **OperationsEdit держат и Двигателист, и Мастер** (кто ведёт двигатель — вносит). Если имелась в виду одна роль — поправить.

### Одобряющий кадровых заявок (M4)
Начальника ОК пока нет → одобряет **суперадмин** (существующий `requestUserDelete`→`confirmUserDelete`). Право `employees.approve` для начальника ОК добавим позже.
