-- Личная карточка СИЗ: ФИО по частям, подразделение и должность.
--
-- Зачем отдельно от 0117: применённую миграцию не правят — 0117 уже накатывалась на
-- стендовых базах, и правка её состава разъезжается с уже применённой схемой.
-- Форма приложения №3 требует три ОТДЕЛЬНЫХ поля (фамилия, имя, отчество), и склеенное
-- ФИО пришлось бы разрезать при печати; подразделение и должность нужны, чтобы карточка
-- печаталась сама, без обращения к справочнику должностей в момент печати.
--
-- Аддитивно: только ADD COLUMN, данные не трогаем.
ALTER TABLE ppe_employee_cards ADD COLUMN IF NOT EXISTS last_name text;
--> statement-breakpoint
ALTER TABLE ppe_employee_cards ADD COLUMN IF NOT EXISTS first_name text;
--> statement-breakpoint
ALTER TABLE ppe_employee_cards ADD COLUMN IF NOT EXISTS middle_name text;
--> statement-breakpoint
ALTER TABLE ppe_employee_cards ADD COLUMN IF NOT EXISTS department_name text;
--> statement-breakpoint
ALTER TABLE ppe_employee_cards ADD COLUMN IF NOT EXISTS post_title text;
