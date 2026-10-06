-- Hashes only: account data/secrets never printed. Full mode verifies restore.
-- Stable mode ignores only the intentional ownership/outbox/journal changes.
SELECT format(
  'SELECT %L, count(*), md5(coalesce(string_agg((to_jsonb(t) %s)::text, '''' ORDER BY (to_jsonb(t) %s)::text), '''')) FROM %I.%I t;',
  table_schema || '.' || table_name,
  CASE WHEN :'mode'='stable' AND table_name='card'
    THEN '- ARRAY[''revision'',''ownerMemberPublicId'']' ELSE '' END,
  CASE WHEN :'mode'='stable' AND table_name='card'
    THEN '- ARRAY[''revision'',''ownerMemberPublicId'']' ELSE '' END,
  table_schema, table_name
)
FROM information_schema.tables
WHERE table_schema IN ('public','drizzle') AND table_type='BASE TABLE'
  AND (:'mode'='full' OR
    (table_schema='public' AND table_name NOT IN ('task_control_change','_card_workspace_members')))
ORDER BY table_schema, table_name
\gexec
SELECT 'function:' || p.proname, md5(pg_get_functiondef(p.oid))
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE :'mode'='full' AND n.nspname='public' AND p.prokind='f'
  AND p.proname LIKE 'task_control_%'
ORDER BY p.proname;
