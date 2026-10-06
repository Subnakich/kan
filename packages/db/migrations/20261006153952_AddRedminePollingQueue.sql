CREATE TABLE "task_control_redmine_request" (
	"publicId" varchar(12) PRIMARY KEY NOT NULL,
	"requestKey" varchar(64) NOT NULL,
	"payloadHash" varchar(64) NOT NULL,
	"kind" varchar(20) NOT NULL,
	"cardPublicId" varchar(12) NOT NULL,
	"boardPublicId" varchar(12) NOT NULL,
	"workspacePublicId" varchar(12) NOT NULL,
	"actorMemberPublicId" varchar(12) NOT NULL,
	"expectedRevision" integer NOT NULL,
	"payload" jsonb NOT NULL,
	"state" varchar(20) DEFAULT 'queued' NOT NULL,
	"result" jsonb,
	"error" text,
	"leaseToken" varchar(36),
	"leaseExpiresAt" timestamp,
	"attempts" integer DEFAULT 0 NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "task_control_redmine_request_requestKey_unique" UNIQUE("requestKey")
);
--> statement-breakpoint
ALTER TABLE "task_control_redmine_request" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "redmine_request_claim_idx" ON "task_control_redmine_request" USING btree ("state","boardPublicId","createdAt");