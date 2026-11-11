-- Сертификат позиции номенклатуры (миграция сервера 0127): «свой сертификат».
--
-- Идентификатор группы — вид СИЗ (спецодежда / обувь / защита от механических
-- воздействий): общий для нескольких позиций и РАЗНЫЙ внутри одного набора норм.
--
-- Тот же DDL продублирован в `ensureClientSchemaParity` (electron-app/src/main/database/migrate.ts)
-- и в android-миграторе (android-app/src/db/migrate.ts); журнал клиентской drizzle-цепочки
-- не бампаем — прецедент 0033–0037.
--
-- Nullable — ровно как на сервере, иначе checkReplicaStrictness уронит pull.

ALTER TABLE `erp_nomenclature` ADD COLUMN `certificate` text;
