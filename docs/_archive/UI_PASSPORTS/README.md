# UI Passports (Windows Client)

Назначение: быстрые «паспорта» интерфейса для ключевых экранов `electron-app`, чтобы изменения UI формулировались одинаково и внедрялись без потерь контекста.

## Как использовать
- Для запроса на UI-правку копируйте шаблон из `01_templates_passport.md`.
- Выберите целевой паспорт экрана/модуля.
- В запросе укажите только изменяемые пункты (`layout`, `density`, `labels`, `behaviour`, `constraints`).
- Для поиска кода используйте раздел `Источники (source map)` в каждом паспорте.

## Содержание
- `00_global_window_passport.md` — глобальный паспорт окна приложения.
- `01_templates_passport.md` — паспорта типовых шаблонов разметки.
- `10_history_production_passport.md` — Мой круг + Производство.
- `11_supply_passport.md` — Снабжение.
- `12_warehouse_passport.md` — Склад.
- `13_business_people_passport.md` — Договоры/контрагенты + Персонал.
- `14_control_admin_passport.md` — Контроль/аналитика, админ и системные экраны.
- `15_page_passports_registry.md` — реестр страниц, табов и ссылок на паспорта/исходники.

## Базовые источники
- Навигация и табы: `electron-app/src/renderer/src/ui/layout/Tabs.tsx`
- Главный роутинг/композиция: `electron-app/src/renderer/src/ui/App.tsx`
- Глобальные стили: `electron-app/src/renderer/src/ui/global.css`
- Стандарт визуала: `docs/UI_VISUAL_STANDARDS.md`

## Правило актуализации
- При изменении структуры окна, шаблона layout или UX ключевого экрана обновляйте соответствующий паспорт в этой папке в той же сессии.
