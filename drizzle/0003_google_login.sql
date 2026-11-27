ALTER TABLE "users" ADD COLUMN "google_sub" text;--> statement-breakpoint
CREATE UNIQUE INDEX "users_google_sub_unique" ON "users" ("google_sub");--> statement-breakpoint
ALTER TABLE "users" DROP CONSTRAINT "users_registered_has_credentials";--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_registered_has_credentials" CHECK ("kind" <> 'registered' OR ("email" IS NOT NULL AND ("password_hash" IS NOT NULL OR "google_sub" IS NOT NULL)));
