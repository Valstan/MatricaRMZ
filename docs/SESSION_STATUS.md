# MatricaRMZ — статус разработки (для продолжения в следующей сессии)

## Карта путей и мест хранения
См. `docs/PATHS.md` — единый справочник по структуре, логам, миграциям и релизам.

Дата обновления: 2026-01-25

## Последние изменения (синхронизация)
- Доменные данные переведены в режим полной репликации.
- Чат остаётся приватным (chat_messages/chat_reads фильтруются по участникам).
- Клиент при `sync_dependency_missing` делает reset + полный pull и повторяет push.
- Добавлена кнопка “Пересинхронизировать сотрудников” в web‑admin (ручной ресинк сотрудников).

## Последний релиз клиента
- `v0.0.38` (выпущено) — исправлена загрузка файлов через диалог выбора, добавлен модуль учета деталей.
- `v0.0.37` (выпущено) — исправлена загрузка файлов на Yandex.Disk + модуль учета деталей (были ошибки компиляции).
- `v0.0.36` (выпущено) — добавлены вложения (файловое хранилище) + права `files.*`.

## Файловое хранилище (VPS)
- Яндекс.Диск: настроен и **проверен** сценарий больших файлов (>10MB) через `/files/yandex/init` (PUT по `uploadUrl`, затем скачивание по `/files/:id/url`).

## Что реализовано

### 1) Модуль «Заявки» (снабжение)
- Вкладка **«Заявки»** (UI-gating по permissions).
- Хранение заявок через `operations.metaJson`:
  - `operation_type='supply_request'`
  - `metaJson.kind='supply_request'`
- Карточка заявки:
  - шапка, статусы/переходы, список товаров, поставки (факт), автосохранение
  - 2 режима печати: **кратко/полно**
  - исправлен подвал печати под шаблон подписей
  - таблица товаров компактнее, кнопка «Добавить позицию» под таблицей
  - drag&drop перестановка строк за ручку
  - вставка символов (⌀ × ± °) работает (через обновление state)
  - qty поля — `type=number` со стрелками ↑↓
- Подсказки товаров:
  - добавлен справочник master-data `product` (EAV) в `EntityTypeCode.Product`
  - в UI используется `datalist` подсказок по `product`

### 2) Делегирование прав (временное + журнал)
- Backend: таблица `permission_delegations` (миграция `backend-api/drizzle/0005_*.sql`), учитывается в `getEffectivePermissionsForUser()`.
- Backend API: `/admin/users/:id/delegations`, `/admin/delegations`, `/admin/delegations/:id/revoke`.
- Electron: UI в `AdminPage` для создания/отзыва делегирования, и периодический `auth.sync` (обновление permissions без перезахода).

## Важные прод-заметки (VPS)

### systemd backend
- сервис: `matricarmz-backend.service`
- executable: `/home/valstan/MatricaRMZ/backend-api/dist/index.js`

После pull новых изменений на VPS:
```bash
cd /home/valstan/MatricaRMZ
pnpm --filter @matricarmz/shared build
pnpm --filter @matricarmz/backend-api build
pnpm --filter @matricarmz/backend-api db:migrate
pnpm --filter @matricarmz/backend-api perm:seed
sudo systemctl restart matricarmz-backend.service
```

## Последние проблемы, которые ловили, и их фиксы

### A) `push HTTP 500 invalid_enum_value received 'supply_request'`
- причина: backend на старом `dist` без нового `operation_type`.
- фикс: пересобрать shared+backend и перезапустить сервис.

### B) `push HTTP 500 FK operations_engine_entity_id...`
- причина: для заявок используется контейнерный `engine_entity_id=00000000-0000-0000-0000-000000000001`, которого не было в `entities`.
- фикс: backend `applyPushBatch.ts` создаёт system container entity/type при приходе `supply_request`.

### 3) Модуль учета деталей
- Backend API: `/parts` (CRUD), `/parts/:id/attributes`, `/parts/:id/files`.
- EAV система: детали хранятся как `entities` типа `part`, атрибуты через `attribute_values`.
- UI: вкладка "Детали", список деталей, карта детали с редактированием атрибутов.
- Права: `parts.view`, `parts.create`, `parts.edit`, `parts.delete`.
- Связи с двигателями: через атрибуты типа `link` в EAV.
- Исправление файлового хранилища: загрузка больших файлов (>10MB) на Yandex.Disk через `net.fetch()` в Electron.



