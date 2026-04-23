-- Backfill directory_tools / directory_goods / directory_services from masterdata entities
-- so erp_nomenclature.directory_ref_id (same UUID as entity) resolves in warehouse upsert.
-- Idempotent: ON CONFLICT DO UPDATE refreshes name and soft-delete flags.

INSERT INTO directory_tools (id, name, is_active, metadata_json, deprecated_at, created_at, updated_at, deleted_at)
SELECT
  e.id,
  COALESCE(
    (
      SELECT NULLIF(trim(both '"' from av.value_json::text), '')
      FROM attribute_values av
      INNER JOIN attribute_defs ad ON ad.id = av.attribute_def_id AND ad.deleted_at IS NULL
      WHERE av.entity_id = e.id
        AND av.deleted_at IS NULL
        AND lower(ad.code) IN ('name', 'title', 'label')
      ORDER BY
        CASE lower(ad.code)
          WHEN 'name' THEN 1
          WHEN 'title' THEN 2
          ELSE 3
        END
      LIMIT 1
    ),
    'Инструмент'
  ),
  (e.deleted_at IS NULL),
  NULL,
  NULL,
  COALESCE(e.created_at, (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint),
  COALESCE(e.updated_at, (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint),
  e.deleted_at
FROM entities e
INNER JOIN entity_types t ON t.id = e.type_id AND t.deleted_at IS NULL
WHERE t.code = 'tool'
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  is_active = EXCLUDED.is_active,
  deleted_at = EXCLUDED.deleted_at,
  updated_at = EXCLUDED.updated_at;

INSERT INTO directory_goods (id, name, is_active, metadata_json, deprecated_at, created_at, updated_at, deleted_at)
SELECT
  e.id,
  COALESCE(
    (
      SELECT NULLIF(trim(both '"' from av.value_json::text), '')
      FROM attribute_values av
      INNER JOIN attribute_defs ad ON ad.id = av.attribute_def_id AND ad.deleted_at IS NULL
      WHERE av.entity_id = e.id
        AND av.deleted_at IS NULL
        AND lower(ad.code) IN ('name', 'title', 'label')
      ORDER BY
        CASE lower(ad.code)
          WHEN 'name' THEN 1
          WHEN 'title' THEN 2
          ELSE 3
        END
      LIMIT 1
    ),
    'Товар'
  ),
  (e.deleted_at IS NULL),
  NULL,
  NULL,
  COALESCE(e.created_at, (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint),
  COALESCE(e.updated_at, (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint),
  e.deleted_at
FROM entities e
INNER JOIN entity_types t ON t.id = e.type_id AND t.deleted_at IS NULL
WHERE t.code IN ('product', 'good')
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  is_active = EXCLUDED.is_active,
  deleted_at = EXCLUDED.deleted_at,
  updated_at = EXCLUDED.updated_at;

INSERT INTO directory_services (id, name, is_active, metadata_json, legacy_service_entity_id, deprecated_at, created_at, updated_at, deleted_at)
SELECT
  e.id,
  COALESCE(
    (
      SELECT NULLIF(trim(both '"' from av.value_json::text), '')
      FROM attribute_values av
      INNER JOIN attribute_defs ad ON ad.id = av.attribute_def_id AND ad.deleted_at IS NULL
      WHERE av.entity_id = e.id
        AND av.deleted_at IS NULL
        AND lower(ad.code) IN ('name', 'title', 'label')
      ORDER BY
        CASE lower(ad.code)
          WHEN 'name' THEN 1
          WHEN 'title' THEN 2
          ELSE 3
        END
      LIMIT 1
    ),
    'Услуга'
  ),
  (e.deleted_at IS NULL),
  NULL,
  NULL,
  NULL,
  COALESCE(e.created_at, (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint),
  COALESCE(e.updated_at, (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint),
  e.deleted_at
FROM entities e
INNER JOIN entity_types t ON t.id = e.type_id AND t.deleted_at IS NULL
WHERE t.code = 'service'
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  is_active = EXCLUDED.is_active,
  deleted_at = EXCLUDED.deleted_at,
  updated_at = EXCLUDED.updated_at;
