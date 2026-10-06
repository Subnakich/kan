-- Preserve existing primary owners as native card participants before changing
-- the guard. Native participant mutations already touch card via child_change.
INSERT INTO _card_workspace_members ("cardId", "workspaceMemberId")
SELECT c.id, m.id FROM card c
JOIN list l ON l.id=c."listId"
JOIN board b ON b.id=l."boardId"
JOIN workspace_members m ON m."publicId"=c."ownerMemberPublicId"
  AND m."workspaceId"=b."workspaceId" AND m.status='active' AND m."deletedAt" IS NULL
WHERE b."taskControlEnabled" AND NOT b."isArchived" AND b."deletedAt" IS NULL
  AND l."deletedAt" IS NULL AND c."deletedAt" IS NULL
ON CONFLICT DO NOTHING;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION task_control_card_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE b record; old_b record; role text; participant_ids text[];
BEGIN
  SELECT board.*, list."taskRole" AS role INTO b FROM list JOIN board ON board.id=list."boardId" WHERE list.id=NEW."listId";
  old_b := b;
  IF TG_OP='UPDATE' THEN
    SELECT board.*, list."taskRole" AS role INTO old_b FROM list JOIN board ON board.id=list."boardId" WHERE list.id=OLD."listId";
    IF old_b."taskControlEnabled" AND (NOT b."taskControlEnabled" OR old_b.id <> b.id) THEN RAISE EXCEPTION 'Task control: moving cards to another board is not supported' USING ERRCODE='23514'; END IF;
  END IF;
  IF NOT b."taskControlEnabled" THEN RETURN NEW; END IF;
  IF NEW."deletedAt" IS NOT NULL THEN IF TG_OP='UPDATE' THEN NEW.revision := OLD.revision+1; END IF; RETURN NEW; END IF;
  IF b."isArchived" OR b."deletedAt" IS NOT NULL THEN RAISE EXCEPTION 'Task control: board is archived' USING ERRCODE='23514'; END IF;
  role := b.role;
  IF role IS NULL THEN RAISE EXCEPTION 'Task control: select a task-control column' USING ERRCODE='23514'; END IF;
  IF TG_OP='INSERT' AND role <> 'review' THEN RAISE EXCEPTION 'Task control: new cards must start in Review' USING ERRCODE='23514'; END IF;
  IF TG_OP='UPDATE' AND old_b.role='review' AND NEW."listId"<>OLD."listId" AND role<>'queue' THEN RAISE EXCEPTION 'Task control: confirm Review by moving to Queue first' USING ERRCODE='23514'; END IF;
  IF NEW."ownerMemberPublicId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM workspace_members WHERE "publicId"=NEW."ownerMemberPublicId" AND "workspaceId"=b."workspaceId" AND status='active' AND "deletedAt" IS NULL) THEN RAISE EXCEPTION 'Task control: responsible person must be an active workspace member' USING ERRCODE='23514'; END IF;
  IF TG_OP='UPDATE' THEN
    SELECT coalesce(array_agg(m."publicId"::text), ARRAY[]::text[]) INTO participant_ids
      FROM _card_workspace_members cm JOIN workspace_members m ON m.id=cm."workspaceMemberId"
      WHERE cm."cardId"=NEW.id AND m."workspaceId"=b."workspaceId" AND m.status='active' AND m."deletedAt" IS NULL;
    IF NEW."ownerMemberPublicId" IS DISTINCT FROM OLD."ownerMemberPublicId" AND NEW."ownerMemberPublicId" IS NOT NULL
      AND NOT (NEW."ownerMemberPublicId"=ANY(participant_ids)) THEN
      RAISE EXCEPTION 'Task control: responsible person must be a card participant' USING ERRCODE='23514';
    END IF;
    IF cardinality(participant_ids)=1 THEN NEW."ownerMemberPublicId" := participant_ids[1];
    ELSIF NEW."ownerMemberPublicId" IS NOT NULL AND NOT (NEW."ownerMemberPublicId"=ANY(participant_ids)) THEN NEW."ownerMemberPublicId" := NULL;
    END IF;
  END IF;
  IF role <> 'review' AND (NEW."ownerMemberPublicId" IS NULL OR btrim(NEW.title)='' OR btrim(regexp_replace(coalesce(NEW.description,''),'<[^>]*>','','g'))='') THEN RAISE EXCEPTION 'Task control: set title, description and responsible person before leaving Review' USING ERRCODE='23514'; END IF;
  IF role='blocked' AND btrim(coalesce(NEW."blockerReason",''))='' THEN RAISE EXCEPTION 'Task control: enter a blocker reason first' USING ERRCODE='23514'; END IF;
  IF TG_OP='UPDATE' THEN
    NEW."deadlineRevision" := OLD."deadlineRevision" + CASE WHEN NEW."dueDate" IS DISTINCT FROM OLD."dueDate" THEN 1 ELSE 0 END;
    IF NEW."listId" IS DISTINCT FROM OLD."listId" THEN NEW."columnEnteredAt" := timezone('UTC',now()); NEW."columnVisitId" := gen_random_uuid(); END IF;
    IF (to_jsonb(NEW) - ARRAY['revision','updatedAt','redmineLink','index']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['revision','updatedAt','redmineLink','index']) THEN NEW.revision := OLD.revision+1;
    ELSE NEW.revision := greatest(OLD.revision, NEW.revision); END IF;
  END IF; RETURN NEW;
END $$;
--> statement-breakpoint
-- Reconcile existing single-participant cards without resetting column timers.
UPDATE card c SET revision=c.revision+1
FROM list l JOIN board b ON b.id=l."boardId"
WHERE c."listId"=l.id AND b."taskControlEnabled" AND NOT b."isArchived"
  AND b."deletedAt" IS NULL AND l."deletedAt" IS NULL AND c."deletedAt" IS NULL
  AND (SELECT count(*) FROM _card_workspace_members cm JOIN workspace_members m ON m.id=cm."workspaceMemberId"
       WHERE cm."cardId"=c.id AND m."workspaceId"=b."workspaceId" AND m.status='active' AND m."deletedAt" IS NULL)=1
  AND c."ownerMemberPublicId" IS DISTINCT FROM
      (SELECT m."publicId" FROM _card_workspace_members cm JOIN workspace_members m ON m.id=cm."workspaceMemberId"
       WHERE cm."cardId"=c.id AND m."workspaceId"=b."workspaceId" AND m.status='active' AND m."deletedAt" IS NULL LIMIT 1);
