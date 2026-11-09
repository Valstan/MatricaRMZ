-- Уборка фикстуры смоука cdp-employee-card-gate.mjs: карточки «Смоукова …» и их значения.
-- Запуск ПОСЛЕ остановки клиента: пока Electron жив, его реплика успеет запихнуть
-- локальные карточки обратно на сервер.
\set ON_ERROR_STOP on
DELETE FROM attribute_values av
  USING entities e, attribute_defs d
 WHERE av.entity_id = e.id
   AND av.attribute_def_id = d.id
   AND e.type_id = (SELECT id FROM entity_types WHERE code='employee' AND deleted_at IS NULL)
   AND d.code = 'full_name'
   AND av.value_json LIKE '%Смоукова%';

DELETE FROM entities e
 WHERE e.type_id = (SELECT id FROM entity_types WHERE code='employee' AND deleted_at IS NULL)
   AND e.id NOT IN (SELECT DISTINCT av.entity_id FROM attribute_values av);
