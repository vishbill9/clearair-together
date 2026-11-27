import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  doublePrecision,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  date,
} from 'drizzle-orm/pg-core';

const id = () => uuid('id').primaryKey().defaultRandom();
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

/** Anonymous or registered account. Anonymous users are created from a signed session cookie. */
export const users = pgTable(
  'users',
  {
    id: id(),
    kind: text('kind').notNull().default('anonymous'),
    /** Lower-cased. Only set for registered accounts. */
    email: text('email'),
    /** scrypt$N$r$p$salt$hash (base64url). Never returned by any API. */
    passwordHash: text('password_hash'),
    displayName: text('display_name'),
    /** Google account id (`sub`) for "Continue with Google". Stable, unlike email. */
    googleSub: text('google_sub'),
    createdAt: createdAt(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('users_kind_check', sql`${t.kind} in ('anonymous','registered')`),
    uniqueIndex('users_email_unique').on(t.email),
    uniqueIndex('users_google_sub_unique').on(t.googleSub),
    check(
      'users_registered_has_credentials',
      sql`${t.kind} <> 'registered' or (${t.email} is not null and (${t.passwordHash} is not null or ${t.googleSub} is not null))`,
    ),
  ],
);

export const households = pgTable(
  'households',
  {
    id: id(),
    ownerUserId: uuid('owner_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    // Coordinates are stored rounded to two decimals (about 1 km) to limit location precision.
    latitude: doublePrecision('latitude').notNull(),
    longitude: doublePrecision('longitude').notNull(),
    approximateLabel: text('approximate_label'),
    countryCode: text('country_code'),
    languageCode: text('language_code').notNull().default('en'),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('households_owner_idx').on(t.ownerUserId),
    check('households_lat_check', sql`${t.latitude} between -90 and 90`),
    check('households_lng_check', sql`${t.longitude} between -180 and 180`),
    check('households_name_len', sql`char_length(${t.name}) between 1 and 80`),
    check('households_country_check', sql`${t.countryCode} is null or ${t.countryCode} ~ '^[A-Z]{2}$'`),
  ],
);

/** People in the household, described only by age group. No names or health details are stored. */
export const householdMembers = pgTable(
  'household_members',
  {
    id: id(),
    householdId: uuid('household_id')
      .notNull()
      .references(() => households.id, { onDelete: 'cascade' }),
    label: text('label').notNull(),
    ageGroup: text('age_group').notNull(),
    needsExtraCaution: boolean('needs_extra_caution').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    index('household_members_household_idx').on(t.householdId),
    check('household_members_age_group', sql`${t.ageGroup} in ('child','adult','older_adult')`),
    check('household_members_label_len', sql`char_length(${t.label}) between 1 and 40`),
  ],
);

export const householdConstraints = pgTable(
  'household_constraints',
  {
    id: id(),
    householdId: uuid('household_id')
      .notNull()
      .references(() => households.id, { onDelete: 'cascade' }),
    commuteMode: text('commute_mode').notNull().default('unknown'),
    canWorkFromHome: boolean('can_work_from_home').notNull().default(false),
    hasAirPurifier: boolean('has_air_purifier').notNull().default(false),
    hasPets: boolean('has_pets').notNull().default(false),
    cookingFuel: text('cooking_fuel').notNull().default('unknown'),
    budgetLevel: text('budget_level').notNull().default('unknown'),
    timeFlexibility: text('time_flexibility').notNull().default('unknown'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('household_constraints_household_uq').on(t.householdId),
    check(
      'household_constraints_commute',
      sql`${t.commuteMode} in ('walk','cycle','bus','metro','car','two_wheeler','rideshare','unknown')`,
    ),
    check(
      'household_constraints_fuel',
      sql`${t.cookingFuel} in ('lpg','electric','induction','piped_gas','biomass','unknown')`,
    ),
    check('household_constraints_budget', sql`${t.budgetLevel} in ('low','medium','high','unknown')`),
    check('household_constraints_time', sql`${t.timeFlexibility} in ('fixed','some','high','unknown')`),
  ],
);

/** Real Google snapshots only. Rows are written after a successful upstream call. */
export const airQualitySnapshots = pgTable(
  'air_quality_snapshots',
  {
    id: id(),
    locationKey: text('location_key').notNull(),
    latitude: doublePrecision('latitude').notNull(),
    longitude: doublePrecision('longitude').notNull(),
    source: text('source').notNull().default('google_air_quality'),
    observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull(),
    regionCode: text('region_code'),
    payload: jsonb('payload').notNull(),
  },
  (t) => [
    index('aq_snapshots_location_fetched_idx').on(t.locationKey, t.fetchedAt),
    check('aq_snapshots_source_check', sql`${t.source} = 'google_air_quality'`),
  ],
);

export const recommendations = pgTable(
  'recommendations',
  {
    id: id(),
    householdId: uuid('household_id')
      .notNull()
      .references(() => households.id, { onDelete: 'cascade' }),
    snapshotId: uuid('snapshot_id').references(() => airQualitySnapshots.id, { onDelete: 'set null' }),
    planDate: date('plan_date').notNull(),
    category: text('category').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    effort: text('effort').notNull(),
    exposureEffect: text('exposure_effect').notNull().default('unknown'),
    emissionsEffect: text('emissions_effect').notNull().default('unknown'),
    origin: text('origin').notNull().default('rules'),
    createdAt: createdAt(),
  },
  (t) => [
    index('recommendations_household_date_idx').on(t.householdId, t.planDate),
    check('recommendations_effort', sql`${t.effort} in ('low','medium','high')`),
    check('recommendations_exposure', sql`${t.exposureEffect} in ('lower','similar','higher','unknown')`),
    check('recommendations_emissions', sql`${t.emissionsEffect} in ('lower','similar','higher','unknown')`),
    check('recommendations_origin', sql`${t.origin} in ('rules','assistant')`),
  ],
);

export const recommendationEvents = pgTable(
  'recommendation_events',
  {
    id: id(),
    recommendationId: uuid('recommendation_id')
      .notNull()
      .references(() => recommendations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    eventType: text('event_type').notNull(),
    note: text('note'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('recommendation_events_uq').on(t.recommendationId, t.userId, t.eventType),
    check(
      'recommendation_events_type',
      sql`${t.eventType} in ('helpful','not_helpful','done','not_feasible')`,
    ),
    check('recommendation_events_note_len', sql`${t.note} is null or char_length(${t.note}) <= 280`),
  ],
);

export const communityChallenges = pgTable(
  'community_challenges',
  {
    id: id(),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    check('community_challenges_dates', sql`${t.endsAt} > ${t.startsAt}`),
    check('community_challenges_title_len', sql`char_length(${t.title}) between 3 and 100`),
  ],
);

export const communityParticipation = pgTable(
  'community_participation',
  {
    id: id(),
    challengeId: uuid('challenge_id')
      .notNull()
      .references(() => communityChallenges.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
    completedActionKeys: text('completed_action_keys')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
  },
  (t) => [uniqueIndex('community_participation_uq').on(t.challengeId, t.userId)],
);

export const auditEvents = pgTable(
  'audit_events',
  {
    id: id(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    eventType: text('event_type').notNull(),
    resourceType: text('resource_type'),
    resourceId: text('resource_id'),
    requestId: text('request_id'),
    clientHash: text('client_hash'),
    metadata: jsonb('metadata')
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: createdAt(),
  },
  (t) => [
    index('audit_events_user_idx').on(t.userId, t.createdAt),
    index('audit_events_type_idx').on(t.eventType),
  ],
);

export const TABLES = [
  'users',
  'households',
  'household_members',
  'household_constraints',
  'air_quality_snapshots',
  'recommendations',
  'recommendation_events',
  'community_challenges',
  'community_participation',
  'audit_events',
] as const;
