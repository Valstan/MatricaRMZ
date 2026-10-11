---

session: main
status: active
updated: 2026-10-11
---

# Session Handoff

> Sticky-note для непрерывности: куда шла нитка, что дальше. История — в `git log`, открытое — в `docs/PENDING_FOLLOWUPS.md`, сделанное — в `docs/COMPLETED.md`. Только активное: старые нитки вычищены (правило раскола «открытое vs сделанное»).

**Status:** ACTIVE
**Updated:** 2026-10-11 (нитка: серверный аудит отгрузки при открытом наряде)
**Branch:** fix/shipment-assembly-server-audit
**Last released version:** v3.72.0 на проде (леджер подписан)

## Текущая нитка

PENDING-пункт «Гейт "Отправлен заказчику ↔ открытый сборочный наряд" —
только UI-вход» — в работе, код готов (backend-only, как и просил пункт):
`setEntityAttribute` при включении `status_customer_sent` у двигателя
сканирует открытые сборочные наряды (`listOpenAssemblyWorkOrdersForEngine` —
зеркало клиентского скана: тот же `deriveWorkOrderStatusCode` +
`isAssemblyWorkOrderBlocking`) и при blocking пишет warning-запись
`engine_shipment_with_open_assembly` в `audit_log` рядом с
`recordEngineStatusAudit`. Жёсткого блока нет сознательно (offline-first).
Тесты `adminMasterdataShipmentAssembly.test.ts` (5, на мок-БД по образцу
delete-gate): скан, запись с номером наряда, два негатива, соседство
со штатным аудитом. Подрыв пройден. PENDING-секция удалена.

## Следующий шаг

Прогнать гейты → открыть PR → дождаться зелёного CI → squash-merge →
дописать строку COMPLETED. Отдельного релиза не требует (backend-only,
сработает со следующим выкатом). CDP-смоук не гнался: серверный аудит,
стенд не требуется.

## Контекст

- Предыдущие шаги: #1266–#1274 смержены в main (строки COMPLETED уже в main).
- Прод: 3.72.0, `.deploy-backup/20261011-005047`. В PENDING — только фоновые долги.
- Локальных веток с un-pushed коммитами: нет. Стенд погашен, Node-ABI возвращён.
