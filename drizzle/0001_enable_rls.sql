-- Row Level Security: deny by default for Supabase's client-facing roles (anon, authenticated).
-- The Node.js server connects with the database owner role (which bypasses RLS) and enforces
-- object-level authorization in application code. No policies are created on purpose: browsers
-- must never read or write these tables directly through PostgREST.
ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "households" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "household_members" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "household_constraints" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "air_quality_snapshots" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "recommendations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "recommendation_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "community_challenges" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "community_participation" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "audit_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "indoor_sensor_readings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "indoor_images" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON ALL TABLES IN SCHEMA public FROM authenticated';
  END IF;
END
$$;
