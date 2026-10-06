-- Full mode proves backup/restore. Stable mode excludes ONLY the additive table
-- and migration journal. Existing cards, members, accounts and functions match.
SELECT format(
  'SELECT %L, count(*), md5(coalesce(string_agg(to_jsonb(t)::text, '''' ORDER BY to_jsonb(t)::text), '''')) FROM %I.%I t;',
  table_schema || '.' || table_name, table_schema, table_name
)
FROM information_schema.tables
WHERE table_schema IN ('public','drizzle') AND table_type='BASE TABLE'
  AND (:'mode'='full' OR
    (table_schema='public' AND table_name <> 'task_control_redmine_request'))
ORDER BY table_schema, table_name
\gexec
SELECT 'function:' || p.proname, md5(pg_get_functiondef(p.oid))
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='public' AND p.prokind='f' AND p.proname LIKE 'task_control_%'
ORDER BY p.proname;
