ALTER TYPE "public"."card_activity_type" ADD VALUE 'card.updated.owner';--> statement-breakpoint
ALTER TYPE "public"."card_activity_type" ADD VALUE 'card.updated.blocker';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "task_control_change" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"publicId" varchar(12) NOT NULL,
	"cardPublicId" varchar(12) NOT NULL,
	"boardPublicId" varchar(12) NOT NULL,
	"revision" integer NOT NULL,
	"kind" varchar(20) NOT NULL,
	"occurredAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "task_control_change_publicId_unique" UNIQUE("publicId")
);
--> statement-breakpoint
ALTER TABLE "task_control_change" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "task_control_import_key" (
	"externalKey" text PRIMARY KEY NOT NULL,
	"payloadHash" varchar(64) NOT NULL,
	"boardPublicId" varchar(12) NOT NULL,
	"cardPublicId" varchar(12) NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"deletedAt" timestamp,
	CONSTRAINT "task_control_import_key_cardPublicId_unique" UNIQUE("cardPublicId")
);
--> statement-breakpoint
ALTER TABLE "task_control_import_key" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "board" ADD COLUMN "taskControlEnabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "card" ADD COLUMN "ownerMemberPublicId" varchar(12);--> statement-breakpoint
ALTER TABLE "card" ADD COLUMN "blockerReason" text;--> statement-breakpoint
ALTER TABLE "card" ADD COLUMN "taskSource" jsonb;--> statement-breakpoint
ALTER TABLE "card" ADD COLUMN "redmineLink" jsonb;--> statement-breakpoint
ALTER TABLE "card" ADD COLUMN "revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "card" ADD COLUMN "deadlineRevision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "card" ADD COLUMN "columnEnteredAt" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "card" ADD COLUMN "columnVisitId" uuid DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "list" ADD COLUMN "taskRole" varchar(20);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_change_board_cursor_idx" ON "task_control_change" USING btree ("boardPublicId","id");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "card" ADD CONSTRAINT "card_ownerMemberPublicId_workspace_members_publicId_fk" FOREIGN KEY ("ownerMemberPublicId") REFERENCES "public"."workspace_members"("publicId") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE list ADD CONSTRAINT task_role_valid CHECK ("taskRole" IS NULL OR "taskRole" IN ('review','queue','in_progress','blocked','done'));
--> statement-breakpoint
CREATE UNIQUE INDEX task_role_board_unique ON list("boardId", "taskRole") WHERE "deletedAt" IS NULL AND "taskRole" IS NOT NULL;
--> statement-breakpoint
-- Serialize task mutations so outbox cursors are ordered by commit, not just sequence allocation.
CREATE FUNCTION task_control_lock() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN PERFORM pg_advisory_xact_lock(712340); RETURN NULL; END $$;
--> statement-breakpoint
CREATE TRIGGER task_control_lock BEFORE INSERT OR UPDATE OR DELETE ON card FOR EACH STATEMENT EXECUTE FUNCTION task_control_lock();
--> statement-breakpoint
CREATE FUNCTION task_control_card_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE b record; old_b record; role text; old_role text;
BEGIN
  SELECT board.*, list."taskRole" AS role INTO b FROM list JOIN board ON board.id=list."boardId" WHERE list.id=NEW."listId";
  IF TG_OP='UPDATE' THEN
    SELECT board.*, list."taskRole" AS role INTO old_b FROM list JOIN board ON board.id=list."boardId" WHERE list.id=OLD."listId";
    IF old_b."taskControlEnabled" AND (NOT b."taskControlEnabled" OR old_b.id <> b.id) THEN
      RAISE EXCEPTION 'Task control: moving cards to another board is not supported' USING ERRCODE='23514';
    END IF;
  END IF;
  IF NOT b."taskControlEnabled" THEN RETURN NEW; END IF;
  IF NEW."deletedAt" IS NOT NULL THEN
    IF TG_OP='UPDATE' THEN NEW.revision := OLD.revision + 1; END IF;
    RETURN NEW;
  END IF;
  IF b."isArchived" OR b."deletedAt" IS NOT NULL THEN RAISE EXCEPTION 'Task control: board is archived' USING ERRCODE='23514'; END IF;
  role := b.role;
  IF role IS NULL THEN RAISE EXCEPTION 'Task control: select a task-control column' USING ERRCODE='23514'; END IF;
  IF TG_OP='INSERT' AND role <> 'review' THEN RAISE EXCEPTION 'Task control: new cards must start in Review' USING ERRCODE='23514'; END IF;
  IF TG_OP='UPDATE' AND old_b.role='review' AND NEW."listId"<>OLD."listId" AND role<>'queue' THEN RAISE EXCEPTION 'Task control: confirm Review by moving to Queue first' USING ERRCODE='23514'; END IF;
  IF NEW."ownerMemberPublicId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM workspace_members WHERE "publicId"=NEW."ownerMemberPublicId" AND "workspaceId"=b."workspaceId" AND status='active' AND "deletedAt" IS NULL) THEN
    RAISE EXCEPTION 'Task control: responsible person must be an active workspace member' USING ERRCODE='23514';
  END IF;
  IF role <> 'review' AND (NEW."ownerMemberPublicId" IS NULL OR NEW."dueDate" IS NULL OR btrim(NEW.title)='' OR btrim(regexp_replace(coalesce(NEW.description,''),'<[^>]*>','','g'))='') THEN
    RAISE EXCEPTION 'Task control: set title, description, responsible person and deadline before leaving Review' USING ERRCODE='23514';
  END IF;
  IF role='blocked' AND btrim(coalesce(NEW."blockerReason",''))='' THEN RAISE EXCEPTION 'Task control: enter a blocker reason first' USING ERRCODE='23514'; END IF;
  IF TG_OP='UPDATE' THEN
    NEW."deadlineRevision" := OLD."deadlineRevision" + CASE WHEN NEW."dueDate" IS DISTINCT FROM OLD."dueDate" THEN 1 ELSE 0 END;
    IF NEW."listId" IS DISTINCT FROM OLD."listId" THEN NEW."columnEnteredAt" := timezone('UTC',now()); NEW."columnVisitId" := gen_random_uuid(); END IF;
    IF (to_jsonb(NEW) - ARRAY['revision','updatedAt','redmineLink','index']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['revision','updatedAt','redmineLink','index']) THEN NEW.revision := OLD.revision+1;
    ELSE NEW.revision := greatest(OLD.revision, NEW.revision); END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER task_control_card_guard BEFORE INSERT OR UPDATE ON card FOR EACH ROW EXECUTE FUNCTION task_control_card_guard();
--> statement-breakpoint
CREATE FUNCTION task_control_outbox() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c record; b record; event_kind text;
BEGIN
  IF TG_OP='DELETE' THEN c:=OLD; event_kind:='deleted'; ELSE c:=NEW; event_kind:=CASE WHEN TG_OP='INSERT' THEN 'created' WHEN NEW."deletedAt" IS NOT NULL THEN 'deleted' ELSE 'updated' END; END IF;
  SELECT board.* INTO b FROM list JOIN board ON board.id=list."boardId" WHERE list.id=c."listId";
  IF NOT b."taskControlEnabled" THEN RETURN NULL; END IF;
  IF TG_OP='UPDATE' AND NEW.revision=OLD.revision AND NEW."redmineLink" IS NOT DISTINCT FROM OLD."redmineLink" THEN RETURN NULL; END IF;
  IF TG_OP='DELETE' AND OLD."deletedAt" IS NOT NULL THEN RETURN NULL; END IF;
  INSERT INTO task_control_change("publicId","cardPublicId","boardPublicId",revision,kind) VALUES (substr(md5(gen_random_uuid()::text),1,12),c."publicId",b."publicId",c.revision,event_kind);
  IF event_kind='deleted' THEN UPDATE task_control_import_key SET "deletedAt"=timezone('UTC',now()) WHERE "cardPublicId"=c."publicId"; END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER task_control_outbox AFTER INSERT OR UPDATE OR DELETE ON card FOR EACH ROW EXECUTE FUNCTION task_control_outbox();
--> statement-breakpoint
CREATE FUNCTION task_control_child_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE row_data jsonb; card_id bigint;
BEGIN
  row_data:=CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
  IF TG_TABLE_NAME='card_checklist_item' THEN SELECT "cardId" INTO card_id FROM card_checklist WHERE id=(row_data->>'checklistId')::bigint;
  ELSE card_id:=(row_data->>'cardId')::bigint; END IF;
  UPDATE card SET revision=revision+1 WHERE id=card_id AND "deletedAt" IS NULL AND "listId" IN (SELECT list.id FROM list JOIN board ON board.id=list."boardId" WHERE board."taskControlEnabled" AND NOT board."isArchived" AND board."deletedAt" IS NULL);
  RETURN NULL;
END $$;
--> statement-breakpoint
DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['card_comments','card_attachment','card_checklist','card_checklist_item','_card_labels','_card_workspace_members'] LOOP
    EXECUTE format('CREATE TRIGGER task_control_lock BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH STATEMENT EXECUTE FUNCTION task_control_lock()',table_name);
    EXECUTE format('CREATE TRIGGER task_control_child_change AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION task_control_child_change()',table_name);
  END LOOP;
END $$;
--> statement-breakpoint
CREATE FUNCTION task_control_list_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."taskRole" IS NOT NULL AND (TG_OP='DELETE' OR NEW."deletedAt" IS NOT NULL OR NEW."taskRole" IS DISTINCT FROM OLD."taskRole") AND EXISTS(SELECT 1 FROM board WHERE id=OLD."boardId" AND "taskControlEnabled" AND "deletedAt" IS NULL) THEN
    RAISE EXCEPTION 'Task control: required columns cannot be removed; rename or reorder them instead' USING ERRCODE='23514';
  END IF; RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
--> statement-breakpoint
CREATE TRIGGER task_control_list_guard BEFORE UPDATE OR DELETE ON list FOR EACH ROW EXECUTE FUNCTION task_control_list_guard();
--> statement-breakpoint
CREATE FUNCTION task_control_board_state() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."taskControlEnabled" AND (NEW."isArchived" IS DISTINCT FROM OLD."isArchived" OR NEW."deletedAt" IS DISTINCT FROM OLD."deletedAt") THEN
    PERFORM pg_advisory_xact_lock(712340);
    INSERT INTO task_control_change("publicId","cardPublicId","boardPublicId",revision,kind)
      SELECT substr(md5(gen_random_uuid()::text),1,12),card."publicId",NEW."publicId",card.revision,CASE WHEN NEW."deletedAt" IS NOT NULL THEN 'deleted' WHEN NEW."isArchived" THEN 'archived' ELSE 'updated' END FROM card JOIN list ON list.id=card."listId" WHERE list."boardId"=NEW.id AND card."deletedAt" IS NULL;
  END IF; RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER task_control_board_state AFTER UPDATE ON board FOR EACH ROW EXECUTE FUNCTION task_control_board_state();
