ALTER TABLE "users" ADD COLUMN "email" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "password_hash" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "display_name" text;--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_unique" ON "users" ("email");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_registered_has_credentials" CHECK ("kind" <> 'registered' OR ("email" IS NOT NULL AND "password_hash" IS NOT NULL));
