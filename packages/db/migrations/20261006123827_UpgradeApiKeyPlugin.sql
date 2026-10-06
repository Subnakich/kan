ALTER TABLE "apiKey" ADD COLUMN "configId" text DEFAULT 'default' NOT NULL;--> statement-breakpoint
CREATE INDEX "apiKey_configId_idx" ON "apiKey" USING btree ("configId");--> statement-breakpoint
CREATE INDEX "apiKey_referenceId_idx" ON "apiKey" USING btree ("userId");