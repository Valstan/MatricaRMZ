# План: Платежи по двигателям (карточка двигателя + контракт + слоты + отчёты)

> При выходе из plan mode первым шагом скопировать этот план в `docs/plans/engine-payments-2026-07.md` (PR-flow, видимость между машинами).

## Context

Владелец (бухгалтерский контур) хочет вести оплаты по каждому двигателю: стоимость по контракту, авансы/доавансы, окончательный расчёт — с итогами (оплачено, переплата/недоплата). С первого аванса идёт отсчёт **90 дней** на ремонт; бухгалтер должен видеть «горящие» двигатели (жёлтый/красный фон в контракте, счётчик в списке контрактов) и собирать их в накопительную служебную записку. Деньги часто приходят раньше двигателей → нужны «слоты» в контракте с распределением аванса, при привязке двигателя платежи слота становятся его платежами. Плюс отчёт-матрица платежей по контракту/ДС.

Решения владельца: подсветка гаснет по факту **ремонта двигателя** (не оплаты); срок — **константа 90 дней**.

## Ключевое архитектурное решение

**Единственный источник истины — контрактный EAV-атрибут `contract_payments`** (dataType `json`), слоты внутри него. Карточка двигателя читает/пишет **через контракт** (`contract_id` у двигателя уже есть). Почему не по-двигательный атрибут: требование двусторонней видимости иначе означает двойное хранение одних денег → вилки при sync (два бухгалтера); платежи по пустым слотам всё равно живут только на контракте; «привязка двигателя» = проставить `engineId` в слоте, без миграции данных. Никаких DDL-миграций — чистый EAV, едет существующим sync.

```ts
// shared/src/domain/payments.ts (новый) + payments.test.ts
type PaymentKind = 'contract_price' | 'advance' | 'extra_advance' | 'final';
interface PaymentRow { id: string; date: string /*ISO*/; amountKop: number /*копейки, int*/;
  kind: PaymentKind; note?: string; countdownStart?: boolean /*макс. один на слот*/ }
interface PaymentSlot { id: string; sectionKey: string /*'primary'|'ДС {seq}'*/;
  engineBrandId?: string; engineId?: string /*пусто = слот без двигателя*/;
  contractPriceKop?: number; payments: PaymentRow[] }
interface ContractPayments { version: 1; slots: PaymentSlot[] }
const REPAIR_COUNTDOWN_DAYS = 90;
```

Чистые функции (все под unit-тестами): `parseContractPayments` (толерантный), `slotTotals` (оплачено/дельта/последний платёж/дата старта отсчёта; дефолт старта — самый ранний `advance`, если флаг не стоит), `countdownStatus(slot, today, engineRepaired)` → `none|ok|warning(>45 дн)|danger(≤20 дн осталось или просрочка)`; гасится `engineRepaired`; `syncSlotsWithPlan` (создать слоты по plan-qty секций, привязать двигатели к свободным слотам, слоты с платежами не удалять; отвязка двигателя оставляет платежи на слоте), `distributeAmount` (равномерно по слотам секции, остаток копеек первому), `findSlotForEngine`, `addPayment/updatePayment/removePayment` (иммутабельно), `burningEnginesCount`.

## Этапы (каждый — свой PR)

### Этап 1 — домен + вкладка «Платежи» в карточке двигателя
- `shared/src/domain/payments.ts` + тесты (parse, totals, пороги отсчёта, округление distribute, идемпотентность syncSlots).
- Регистрация attr `contract_payments` (json) у контракта: `CONTRACT_ACCOUNTING_FIELDS` / `ensureAttributeDefs` в [ContractDetailsPage.tsx](electron-app/src/renderer/src/ui/pages/ContractDetailsPage.tsx) (~строка 92) + аналогично в engine-контексте (образец `reclamation_*`, [EngineDetailsPage.tsx:1160](electron-app/src/renderer/src/ui/pages/EngineDetailsPage.tsx)).
- JSON-ref walkers: слоты содержат `engineId` → добавить `contract_payments` в `shared/src/domain/entityReference.ts` (~143) и `backend-api/src/services/adminMasterdataService.ts` (~503).
- [EngineDetailsPage.tsx:39-41](electron-app/src/renderer/src/ui/pages/EngineDetailsPage.tsx): `'payments'` в `EngineCardTab` + `ENGINE_CARD_TABS`; продублированный union в `App.tsx:2416/2422`. Новый компонент `ui/pages/engine/EnginePaymentsTab.tsx`: грузит `contract_payments` контракта по `contract_id`, `findSlotForEngine`; редактируемая таблица строк (дата — `UnifiedDateInput`, сумма в рублях UI ⇄ копейки хранение, вид платежа, radio-чекбокс «старт отсчёта» с единственностью); футер: оплачено / переплата-недоплата vs стоимость. Сохранение = read-modify-write всего `contract_payments` **на контракте** (setAttr generic). Нет контракта → плейсхолдер.

### Этап 2 — контракт: колонки, подсветка, слоты, распределение
- [ContractDetailsPage.tsx](electron-app/src/renderer/src/ui/pages/ContractDetailsPage.tsx): загрузка/parse; на load — `syncSlotsWithPlan` (запись назад только при реальном diff). В таблице привязанных двигателей `SectionEditor` (~772-840) колонки: оплачено, последний платёж, первый аванс, «дней осталось»; фон строки от `countdownStatus` — новая `utils/paymentCountdownVisual.ts` + тест (образец лестницы — `utils/contractProgressVisual.ts`). Признак «отремонтирован» — из уже показываемого статуса двигателя.
- Подтаблица пустых слотов секции с редактированием платежей + кнопка «Распределить аванс» (сумма+вид+дата → `distributeAmount`).

### Этап 3 — список контрактов
- [ContractsPage.tsx](electron-app/src/renderer/src/ui/pages/ContractsPage.tsx): batch-загрузка `contract_payments`, колонка «Горящие» = `burningEnginesCount`, красный бейдж (образец cell-visual, строки 165-225). Признак ремонта на уровне списка — из доступного статусного источника; если его нет дёшево — считать только по платежам (принятое приближение, отметить в PR).

### Этап 4 — служебная записка
- Чекбоксы на строках двигателей в `SectionEditor` → кнопка «Служебная записка»: один HTML-документ по отмеченным (номер, марка, секция, оплачено, статус отсчёта), новый `utils/serviceMemo.ts`, печать через `openPrintPreview` ([utils/printPreview.ts](electron-app/src/renderer/src/ui/utils/printPreview.ts) — секции с чекбоксами, редактируемый предпросмотр). Текст записки — заготовка, доработаем отдельно.

### Этап 5 — отчёты
- `shared/src/domain/reports.ts`: пресет `contract_payments_matrix` (тема contracts; параметры: контракт + опционально ДС — образец `engines_contracts_overview`) и `payments_overview` (период, заказчик).
- `electron-app/src/main/services/reports/presets/payments.ts` + wiring в `dispatch.ts`: матрица — строки=слоты/двигатели, динамические колонки по числу доавансов, колонки стоимость/аванс/доаванс №n/окончательный/итого/переплата-недоплата, шапка = реквизиты контракта, строка «Итого» по всем колонкам; рендер `renderReportTableHtml`. Печать — автоматически через существующий `ReportPresetPage` → `openPrintPreview`.

## Сквозные предосторожности
- `exactOptionalPropertyTypes`: не присваивать `undefined` опциональным (`engineId`, `note`) — conditional spread.
- Read-modify-write одного крупного атрибута: писать только после пользовательской правки / реального diff syncSlots; перед записью перечитывать.
- Деньги — целые копейки; общий форматтер в shared (согласие UI и отчётов); есть `formatRuMoney` в `utils/dateUtils.ts` — сверить/переиспользовать.
- Отвязка двигателя от секции: платежи остаются на слоте («деньги без двигателя») — описать владельцу в PR.

## Verification
- `corepack pnpm -r typecheck` (по пакетам последовательно — гонка shared/dist), `lint`, тесты shared (`payments.test.ts`, `paymentCountdownVisual.test.ts`) + backend test suite.
- CDP-смоук (`verifier-electron`, PG 5433, профиль PC40): контракт с планом 2 двигателя → пустые слоты → «Распределить аванс» 100 000 ₽ → привязать TEST-001 → в карточке двигателя вкладка «Платежи» показывает 50 000 + флаг отсчёта → добавить платёж из карточки двигателя → итоги в контракте обновились → сдвинуть дату старта в прошлое → строка красная → список контрактов «Горящие: 1» → отчёт-матрица + предпросмотр служебной записки.
