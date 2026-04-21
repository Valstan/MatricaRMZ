# Паспорт: Контроль/аналитика, админ и системные экраны

## Зона
- Группа: `control`
- Табы: `reports`, `changes`, `audit`, `notes`, `masterdata`, `admin`
- Системные: `auth`, `settings`

## Ключевые UX-цели
- Отчёты: понятный билд фильтров и предсказуемый формат результата.
- Аудит/изменения: быстрый forensic-поиск по событиям.
- Админ/справочники: безопасное редактирование критичных данных.

## Экранные паттерны
- Отчеты: T4 (`ReportPresetPage` + custom views)
- Журналы: T1 с плотной фильтрацией
- Админ/справочники: T5 + карточки T2

## Source map
- Отчёты: `ReportsPage.tsx`, `ReportPresetPage.tsx`, `AssemblyForecastReportView.tsx`
- Изменения: `ChangesPage.tsx`
- Аудит: `SuperadminAuditPage.tsx`
- Заметки: `NotesPage.tsx`
- Справочники: `MasterdataPage.tsx`, `MasterdataDirectoryPage.tsx`
- Админ: `AdminPage.tsx`, `AdminUsersPage.tsx`, `AdminRolesPage.tsx`
- Настройки/авторизация: `SettingsPage.tsx`, `AuthPage.tsx`

## Важные ограничения
- Для отчётов важно не ломать экспорт и структуру данных ради косметики.
- Для админ-экранов приоритет — ясность рисков и явные подтверждения действий.
