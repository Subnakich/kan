-- Custom SQL migration file, put your code below! --
-- A PL/pgSQL record must be assigned before a boolean expression references it,
-- even when TG_OP would short-circuit the expression for INSERT.
CREATE OR REPLACE FUNCTION task_control_card_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE b record; old_b record; role text;
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
  IF role <> 'review' AND (NEW."ownerMemberPublicId" IS NULL OR NEW."dueDate" IS NULL OR btrim(NEW.title)='' OR btrim(regexp_replace(coalesce(NEW.description,''),'<[^>]*>','','g'))='') THEN RAISE EXCEPTION 'Task control: set title, description, responsible person and deadline before leaving Review' USING ERRCODE='23514'; END IF;
  IF role='blocked' AND btrim(coalesce(NEW."blockerReason",''))='' THEN RAISE EXCEPTION 'Task control: enter a blocker reason first' USING ERRCODE='23514'; END IF;
  IF TG_OP='UPDATE' THEN
    NEW."deadlineRevision" := OLD."deadlineRevision" + CASE WHEN NEW."dueDate" IS DISTINCT FROM OLD."dueDate" THEN 1 ELSE 0 END;
    IF NEW."listId" IS DISTINCT FROM OLD."listId" THEN NEW."columnEnteredAt" := timezone('UTC',now()); NEW."columnVisitId" := gen_random_uuid(); END IF;
    IF (to_jsonb(NEW) - ARRAY['revision','updatedAt','redmineLink','index']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['revision','updatedAt','redmineLink','index']) THEN NEW.revision := OLD.revision+1;
    ELSE NEW.revision := greatest(OLD.revision, NEW.revision); END IF;
  END IF; RETURN NEW;
END $$;
