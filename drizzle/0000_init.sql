CREATE TABLE "air_quality_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"location_key" text NOT NULL,
	"latitude" double precision NOT NULL,
	"longitude" double precision NOT NULL,
	"source" text DEFAULT 'google_air_quality' NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	"region_code" text,
	"payload" jsonb NOT NULL,
	CONSTRAINT "aq_snapshots_source_check" CHECK ("air_quality_snapshots"."source" = 'google_air_quality')
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"event_type" text NOT NULL,
	"resource_type" text,
	"resource_id" text,
	"request_id" text,
	"client_hash" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "community_challenges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_by" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "community_challenges_dates" CHECK ("community_challenges"."ends_at" > "community_challenges"."starts_at"),
	CONSTRAINT "community_challenges_title_len" CHECK (char_length("community_challenges"."title") between 3 and 100)
);
--> statement-breakpoint
CREATE TABLE "community_participation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"challenge_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_action_keys" text[] DEFAULT '{}'::text[] NOT NULL
);
--> statement-breakpoint
CREATE TABLE "household_constraints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"commute_mode" text DEFAULT 'unknown' NOT NULL,
	"can_work_from_home" boolean DEFAULT false NOT NULL,
	"has_air_purifier" boolean DEFAULT false NOT NULL,
	"has_pets" boolean DEFAULT false NOT NULL,
	"cooking_fuel" text DEFAULT 'unknown' NOT NULL,
	"budget_level" text DEFAULT 'unknown' NOT NULL,
	"time_flexibility" text DEFAULT 'unknown' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "household_constraints_commute" CHECK ("household_constraints"."commute_mode" in ('walk','cycle','bus','metro','car','two_wheeler','rideshare','unknown')),
	CONSTRAINT "household_constraints_fuel" CHECK ("household_constraints"."cooking_fuel" in ('lpg','electric','induction','piped_gas','biomass','unknown')),
	CONSTRAINT "household_constraints_budget" CHECK ("household_constraints"."budget_level" in ('low','medium','high','unknown')),
	CONSTRAINT "household_constraints_time" CHECK ("household_constraints"."time_flexibility" in ('fixed','some','high','unknown'))
);
--> statement-breakpoint
CREATE TABLE "household_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"label" text NOT NULL,
	"age_group" text NOT NULL,
	"needs_extra_caution" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "household_members_age_group" CHECK ("household_members"."age_group" in ('child','adult','older_adult')),
	CONSTRAINT "household_members_label_len" CHECK (char_length("household_members"."label") between 1 and 40)
);
--> statement-breakpoint
CREATE TABLE "households" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"latitude" double precision NOT NULL,
	"longitude" double precision NOT NULL,
	"approximate_label" text,
	"country_code" text,
	"language_code" text DEFAULT 'en' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "households_lat_check" CHECK ("households"."latitude" between -90 and 90),
	CONSTRAINT "households_lng_check" CHECK ("households"."longitude" between -180 and 180),
	CONSTRAINT "households_name_len" CHECK (char_length("households"."name") between 1 and 80),
	CONSTRAINT "households_country_check" CHECK ("households"."country_code" is null or "households"."country_code" ~ '^[A-Z]{2}$')
);
--> statement-breakpoint
CREATE TABLE "indoor_images" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"mime_type" text NOT NULL,
	"ciphertext" "bytea" NOT NULL,
	"iv" "bytea" NOT NULL,
	"auth_tag" "bytea" NOT NULL,
	"consented_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "indoor_sensor_readings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"device_id" text NOT NULL,
	"device_label" text,
	"pollutant" text NOT NULL,
	"unit" text NOT NULL,
	"value" double precision NOT NULL,
	"measured_at" timestamp with time zone NOT NULL,
	"calibrated_at" timestamp with time zone,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "indoor_readings_value_check" CHECK ("indoor_sensor_readings"."value" >= 0)
);
--> statement-breakpoint
CREATE TABLE "recommendation_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recommendation_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recommendation_events_type" CHECK ("recommendation_events"."event_type" in ('helpful','not_helpful','done','not_feasible')),
	CONSTRAINT "recommendation_events_note_len" CHECK ("recommendation_events"."note" is null or char_length("recommendation_events"."note") <= 280)
);
--> statement-breakpoint
CREATE TABLE "recommendations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"snapshot_id" uuid,
	"plan_date" date NOT NULL,
	"category" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"effort" text NOT NULL,
	"exposure_effect" text DEFAULT 'unknown' NOT NULL,
	"emissions_effect" text DEFAULT 'unknown' NOT NULL,
	"origin" text DEFAULT 'rules' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recommendations_effort" CHECK ("recommendations"."effort" in ('low','medium','high')),
	CONSTRAINT "recommendations_exposure" CHECK ("recommendations"."exposure_effect" in ('lower','similar','higher','unknown')),
	CONSTRAINT "recommendations_emissions" CHECK ("recommendations"."emissions_effect" in ('lower','similar','higher','unknown')),
	CONSTRAINT "recommendations_origin" CHECK ("recommendations"."origin" in ('rules','assistant'))
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text DEFAULT 'anonymous' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_kind_check" CHECK ("users"."kind" in ('anonymous','registered'))
);
--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_challenges" ADD CONSTRAINT "community_challenges_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_participation" ADD CONSTRAINT "community_participation_challenge_id_community_challenges_id_fk" FOREIGN KEY ("challenge_id") REFERENCES "public"."community_challenges"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_participation" ADD CONSTRAINT "community_participation_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "household_constraints" ADD CONSTRAINT "household_constraints_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "household_members" ADD CONSTRAINT "household_members_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "households" ADD CONSTRAINT "households_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "indoor_images" ADD CONSTRAINT "indoor_images_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "indoor_images" ADD CONSTRAINT "indoor_images_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "indoor_sensor_readings" ADD CONSTRAINT "indoor_sensor_readings_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recommendation_events" ADD CONSTRAINT "recommendation_events_recommendation_id_recommendations_id_fk" FOREIGN KEY ("recommendation_id") REFERENCES "public"."recommendations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recommendation_events" ADD CONSTRAINT "recommendation_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recommendations" ADD CONSTRAINT "recommendations_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recommendations" ADD CONSTRAINT "recommendations_snapshot_id_air_quality_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."air_quality_snapshots"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "aq_snapshots_location_fetched_idx" ON "air_quality_snapshots" USING btree ("location_key","fetched_at");--> statement-breakpoint
CREATE INDEX "audit_events_user_idx" ON "audit_events" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_events_type_idx" ON "audit_events" USING btree ("event_type");--> statement-breakpoint
CREATE UNIQUE INDEX "community_participation_uq" ON "community_participation" USING btree ("challenge_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "household_constraints_household_uq" ON "household_constraints" USING btree ("household_id");--> statement-breakpoint
CREATE INDEX "household_members_household_idx" ON "household_members" USING btree ("household_id");--> statement-breakpoint
CREATE INDEX "households_owner_idx" ON "households" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "indoor_images_household_idx" ON "indoor_images" USING btree ("household_id");--> statement-breakpoint
CREATE INDEX "indoor_images_expiry_idx" ON "indoor_images" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "indoor_readings_lookup_idx" ON "indoor_sensor_readings" USING btree ("household_id","pollutant","measured_at");--> statement-breakpoint
CREATE UNIQUE INDEX "recommendation_events_uq" ON "recommendation_events" USING btree ("recommendation_id","user_id","event_type");--> statement-breakpoint
CREATE INDEX "recommendations_household_date_idx" ON "recommendations" USING btree ("household_id","plan_date");