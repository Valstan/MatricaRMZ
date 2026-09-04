-- D-073 (решение владельца 03.09.2026): вложения не удаляются никогда; хранилище — Я.Диск,
-- бокс — кэш на несколько дней. Чтобы окно кэша выбирать по наблюдению, а не наугад,
-- каждая выдача файла считается.
--
-- access_count / last_accessed_at — счётчик обращений: GET /files/:id и /files/:id/url.
-- local_cached_at — когда локальная копия положена в кэш (для строк storage_kind='yandex'
-- local_rel_path теперь означает «есть кэш-копия», а не «единственная копия»).
--
-- Все три колонки безопасны для старых бинарей: рантайм до этой миграции их не читает.

ALTER TABLE file_assets ADD COLUMN IF NOT EXISTS access_count bigint NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE file_assets ADD COLUMN IF NOT EXISTS last_accessed_at bigint;
--> statement-breakpoint
ALTER TABLE file_assets ADD COLUMN IF NOT EXISTS local_cached_at bigint;
--> statement-breakpoint
-- Сборщик кэша ищет «yandex-строки с локальной копией старше TTL» — частичный индекс держит
-- этот проход дешёвым при любом числе строк без кэша.
CREATE INDEX IF NOT EXISTS file_assets_cache_sweep_idx
  ON file_assets (last_accessed_at, local_cached_at, created_at)
  WHERE storage_kind = 'yandex' AND local_rel_path IS NOT NULL AND deleted_at IS NULL;
