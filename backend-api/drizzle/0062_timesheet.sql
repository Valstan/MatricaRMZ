CREATE TABLE "timesheet_codes" (
	"code" text PRIMARY KEY NOT NULL,
	"num_code" text DEFAULT '' NOT NULL,
	"title" text NOT NULL,
	"counts_as_worked" boolean DEFAULT false NOT NULL,
	"default_hours" numeric(4, 2),
	"color" text,
	"sort" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "timesheets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workshop_id" uuid NOT NULL,
	"year" integer NOT NULL,
	"month" integer NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"week_mode" integer DEFAULT 6 NOT NULL,
	"norm_hours" numeric(6, 2),
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"deleted_at" bigint
);
--> statement-breakpoint
CREATE TABLE "timesheet_rows" (
	"id" uuid PRIMARY KEY NOT NULL,
	"timesheet_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"tab_number" text,
	"position" text,
	"sort" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "timesheet_cells" (
	"id" uuid PRIMARY KEY NOT NULL,
	"row_id" uuid NOT NULL,
	"day" integer NOT NULL,
	"code" text,
	"hours" numeric(4, 2)
);
--> statement-breakpoint
ALTER TABLE "timesheets" ADD CONSTRAINT "timesheets_workshop_id_directory_workshops_id_fk" FOREIGN KEY ("workshop_id") REFERENCES "public"."directory_workshops"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "timesheet_rows" ADD CONSTRAINT "timesheet_rows_timesheet_id_timesheets_id_fk" FOREIGN KEY ("timesheet_id") REFERENCES "public"."timesheets"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "timesheet_rows" ADD CONSTRAINT "timesheet_rows_employee_id_entities_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "timesheet_cells" ADD CONSTRAINT "timesheet_cells_row_id_timesheet_rows_id_fk" FOREIGN KEY ("row_id") REFERENCES "public"."timesheet_rows"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "timesheets_workshop_period_uq" ON "timesheets" USING btree ("workshop_id","year","month") WHERE "timesheets"."deleted_at" is null;
--> statement-breakpoint
CREATE INDEX "timesheet_rows_timesheet_idx" ON "timesheet_rows" USING btree ("timesheet_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "timesheet_rows_timesheet_employee_uq" ON "timesheet_rows" USING btree ("timesheet_id","employee_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "timesheet_cells_row_day_uq" ON "timesheet_cells" USING btree ("row_id","day");
--> statement-breakpoint
INSERT INTO "timesheet_codes" ("code","num_code","title","counts_as_worked","default_hours","color","sort","is_active","created_at","updated_at") VALUES
	('Я','01','Явка (работа в дневное время)',true,8,'#dcfce7',10,true,1781049600000,1781049600000),
	('Н','02','Работа в ночное время',true,NULL,'#e0e7ff',20,true,1781049600000,1781049600000),
	('РВ','03','Работа в выходные и нерабочие праздничные дни',true,NULL,'#fef9c3',30,true,1781049600000,1781049600000),
	('С','04','Сверхурочная работа',true,NULL,'#ffedd5',40,true,1781049600000,1781049600000),
	('К','06','Служебная командировка',true,NULL,'#cffafe',50,true,1781049600000,1781049600000),
	('ПК','07','Повышение квалификации с отрывом от работы',false,NULL,NULL,60,true,1781049600000,1781049600000),
	('ОТ','09','Ежегодный основной оплачиваемый отпуск',false,NULL,'#dbeafe',70,true,1781049600000,1781049600000),
	('ОД','10','Ежегодный дополнительный оплачиваемый отпуск',false,NULL,'#dbeafe',80,true,1781049600000,1781049600000),
	('У','11','Учебный отпуск (с сохранением заработка)',false,NULL,NULL,90,true,1781049600000,1781049600000),
	('Р','14','Отпуск по беременности и родам',false,NULL,NULL,100,true,1781049600000,1781049600000),
	('ОЖ','15','Отпуск по уходу за ребёнком',false,NULL,NULL,110,true,1781049600000,1781049600000),
	('ДО','16','Отпуск без сохранения з/п (с разрешения работодателя)',false,NULL,NULL,120,true,1781049600000,1781049600000),
	('Б','19','Временная нетрудоспособность (с пособием)',false,NULL,'#fee2e2',130,true,1781049600000,1781049600000),
	('Т','20','Нетрудоспособность без назначения пособия',false,NULL,'#fee2e2',140,true,1781049600000,1781049600000),
	('ПВ','22','Время вынужденного прогула',false,NULL,NULL,150,true,1781049600000,1781049600000),
	('Г','23','Невыходы на время гос./общественных обязанностей',false,NULL,NULL,160,true,1781049600000,1781049600000),
	('ПР','24','Прогул',false,NULL,'#fca5a5',170,true,1781049600000,1781049600000),
	('В','26','Выходной / нерабочий праздничный день',false,NULL,'#f1f5f9',180,true,1781049600000,1781049600000),
	('НН','30','Неявка по невыясненным причинам',false,NULL,'#fde68a',190,true,1781049600000,1781049600000)
ON CONFLICT ("code") DO NOTHING;
