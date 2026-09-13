/**
 * Database schema.
 *
 * Every tenant-owned table carries `business_id` as its first column after the
 * primary key, and every one of them has a row-level security policy in the
 * migration keyed on it. The application also filters by `business_id`
 * explicitly in every repository — the RLS policy exists so that the day
 * someone forgets, the query returns nothing instead of another towing
 * company's leads.
 */

import { relations } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/* -------------------------------------------------------------------------- */
/*  Enums                                                                     */
/* -------------------------------------------------------------------------- */

export const businessStatusEnum = pgEnum('business_status', ['active', 'suspended']);
export const userRoleEnum = pgEnum('user_role', ['owner', 'manager', 'agent']);
export const receptionistToneEnum = pgEnum('receptionist_tone', [
  'professional',
  'friendly',
  'calm',
]);
export const fallbackBehaviorEnum = pgEnum('fallback_behavior', [
  'callback',
  'emergency_contact',
]);
export const callDirectionEnum = pgEnum('call_direction', ['inbound', 'outbound']);
export const callStatusEnum = pgEnum('call_status', [
  'in_progress',
  'completed',
  'failed',
]);
export const callOutcomeEnum = pgEnum('call_outcome', [
  'lead_created',
  'callback_created',
  'faq_answered',
  'abandoned',
  'error',
]);
export const speakerEnum = pgEnum('speaker', ['ai', 'customer', 'system']);
export const leadStatusEnum = pgEnum('lead_status', [
  'new',
  'contacted',
  'completed',
  'cancelled',
]);
export const callbackStatusEnum = pgEnum('callback_status', ['open', 'resolved']);
export const notificationChannelEnum = pgEnum('notification_channel', ['whatsapp']);
export const notificationStatusEnum = pgEnum('notification_status', [
  'pending',
  'sent',
  'failed',
  'dead',
]);

/* -------------------------------------------------------------------------- */
/*  Tenants                                                                   */
/* -------------------------------------------------------------------------- */

export const businesses = pgTable('businesses', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  phone: text('phone'),
  website: text('website'),
  address: text('address'),
  timezone: text('timezone').notNull().default('UTC'),
  /** Free-text areas the operator serves, used to answer coverage questions. */
  serviceAreas: jsonb('service_areas').$type<string[]>().notNull().default([]),
  businessHours: jsonb('business_hours')
    .$type<Array<{ day: number; open: string; close: string; closed: boolean }>>()
    .notNull()
    .default([]),
  pricingInfo: text('pricing_info'),
  emergencyContact: text('emergency_contact'),
  /** Where lead notifications are delivered. E.164. */
  whatsappNumber: text('whatsapp_number'),
  /** Country prefix used to normalise numbers a caller reads out. */
  defaultRegionPrefix: text('default_region_prefix'),
  status: businessStatusEnum('status').notNull().default('active'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    name: text('name').notNull(),
    role: userRoleEnum('role').notNull().default('owner'),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('users_email_unique').on(t.email),
    index('users_business_idx').on(t.businessId),
  ],
);

export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    /** Only a hash is stored, so a database leak does not yield live sessions. */
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('refresh_tokens_hash_unique').on(t.tokenHash),
    index('refresh_tokens_user_idx').on(t.userId),
  ],
);

export const businessSettings = pgTable(
  'business_settings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    greeting: text('greeting'),
    tone: receptionistToneEnum('tone').notNull().default('friendly'),
    /**
     * Operator-authored style guidance. Rendered into the prompt inside a
     * fenced, explicitly-untrusted block; it can shape wording but cannot
     * override the workflow or the guardrails.
     */
    businessInstructions: text('business_instructions'),
    faq: jsonb('faq')
      .$type<Array<{ question: string; answer: string }>>()
      .notNull()
      .default([]),
    fallbackBehavior: fallbackBehaviorEnum('fallback_behavior')
      .notNull()
      .default('callback'),
    voiceId: text('voice_id'),
    language: text('language').notNull().default('en'),
    maxCallSeconds: integer('max_call_seconds').notNull().default(300),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('business_settings_business_unique').on(t.businessId)],
);

export const services = pgTable(
  'services',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    isActive: boolean('is_active').notNull().default(true),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('services_business_idx').on(t.businessId)],
);

/**
 * Inbound routing. A call arrives with a `To` number and nothing else; this is
 * what turns it into a tenant. Without it there is no multi-tenant telephony.
 */
export const phoneNumbers = pgTable(
  'phone_numbers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    e164: text('e164').notNull(),
    provider: text('provider').notNull().default('twilio'),
    providerSid: text('provider_sid'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('phone_numbers_e164_unique').on(t.e164),
    index('phone_numbers_business_idx').on(t.businessId),
  ],
);

/* -------------------------------------------------------------------------- */
/*  Calls                                                                     */
/* -------------------------------------------------------------------------- */

export const calls = pgTable(
  'calls',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull().default('twilio'),
    providerCallSid: text('provider_call_sid'),
    fromNumber: text('from_number').notNull(),
    toNumber: text('to_number').notNull(),
    direction: callDirectionEnum('direction').notNull().default('inbound'),
    status: callStatusEnum('status').notNull().default('in_progress'),
    outcome: callOutcomeEnum('outcome'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    durationSeconds: integer('duration_seconds'),
    /** The state the conversation ended in, for debugging stuck flows. */
    finalState: text('final_state'),
    /** Snapshot of the collected slots, including partial ones. */
    collectedData: jsonb('collected_data').$type<Record<string, unknown>>(),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('calls_provider_sid_unique').on(t.providerCallSid),
    index('calls_business_started_idx').on(t.businessId, t.startedAt),
    index('calls_from_number_idx').on(t.fromNumber),
  ],
);

/**
 * The per-call audit trail. Production call debugging depends on this being
 * complete, so the engine emits an event for every decision it makes.
 */
export const callEvents = pgTable(
  'call_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    callId: uuid('call_id')
      .notNull()
      .references(() => calls.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    sequence: integer('sequence').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('call_events_call_sequence_unique').on(t.callId, t.sequence),
    index('call_events_business_idx').on(t.businessId),
  ],
);

export const transcripts = pgTable(
  'transcripts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    callId: uuid('call_id')
      .notNull()
      .references(() => calls.id, { onDelete: 'cascade' }),
    turnIndex: integer('turn_index').notNull(),
    speaker: speakerEnum('speaker').notNull(),
    text: text('text').notNull(),
    /** Speech-recognition confidence, when the provider reports one. */
    confidence: text('confidence'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('transcripts_call_turn_unique').on(t.callId, t.turnIndex),
    index('transcripts_business_idx').on(t.businessId),
  ],
);

/* -------------------------------------------------------------------------- */
/*  Output                                                                    */
/* -------------------------------------------------------------------------- */

export const leads = pgTable(
  'leads',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    callId: uuid('call_id').references(() => calls.id, { onDelete: 'set null' }),

    customerName: text('customer_name').notNull(),
    customerPhone: text('customer_phone').notNull(),
    service: text('service').notNull(),
    location: text('location').notNull(),

    // Null means "the caller did not say", never a placeholder string.
    destination: text('destination'),
    vehicleMake: text('vehicle_make'),
    vehicleModel: text('vehicle_model'),
    vehicleType: text('vehicle_type'),
    vehicleCondition: text('vehicle_condition'),
    vehicleMovable: boolean('vehicle_movable'),
    additionalNotes: text('additional_notes'),
    /** 'high' for urgent or unsafe situations, decided in code during the call. */
    priority: text('priority').$type<'normal' | 'high'>().notNull().default('normal'),
    /** Where each detail came from: stated, inferred, unsure or caller_id. */
    fieldSources: jsonb('field_sources').$type<Record<string, string>>().notNull().default({}),

    source: text('source').notNull().default('ai_receptionist'),
    status: leadStatusEnum('status').notNull().default('new'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('leads_business_status_created_idx').on(t.businessId, t.status, t.createdAt),
    index('leads_customer_phone_idx').on(t.customerPhone),
    index('leads_call_idx').on(t.callId),
  ],
);

export const callbackRequests = pgTable(
  'callback_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    callId: uuid('call_id').references(() => calls.id, { onDelete: 'set null' }),
    customerName: text('customer_name'),
    customerPhone: text('customer_phone').notNull(),
    reason: text('reason').notNull(),
    /** Frozen copy of the transcript, so the record stays readable on its own. */
    transcriptSnapshot: text('transcript_snapshot'),
    status: callbackStatusEnum('status').notNull().default('open'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('callback_requests_business_status_idx').on(t.businessId, t.status),
    index('callback_requests_call_idx').on(t.callId),
  ],
);

/**
 * Outbound notification attempts.
 *
 * A row is written in the same transaction as the lead it announces, before any
 * network call is made. That ordering is what guarantees a WhatsApp outage
 * costs a notification, never the lead.
 */
export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    channel: notificationChannelEnum('channel').notNull().default('whatsapp'),
    /** Destination address, captured at creation so later config edits cannot rewrite history. */
    target: text('target').notNull(),
    leadId: uuid('lead_id').references(() => leads.id, { onDelete: 'cascade' }),
    callbackRequestId: uuid('callback_request_id').references(() => callbackRequests.id, {
      onDelete: 'cascade',
    }),
    /** The rendered message, so what was sent is always recoverable. */
    payload: text('payload').notNull(),
    status: notificationStatusEnum('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    providerMessageId: text('provider_message_id'),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    nextRetryAt: timestamp('next_retry_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('notifications_status_retry_idx').on(t.status, t.nextRetryAt),
    index('notifications_business_idx').on(t.businessId),
    index('notifications_lead_idx').on(t.leadId),
  ],
);

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    action: text('action').notNull(),
    resourceType: text('resource_type').notNull(),
    resourceId: text('resource_id'),
    ip: text('ip'),
    userAgent: text('user_agent'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('audit_logs_business_created_idx').on(t.businessId, t.createdAt)],
);

/* -------------------------------------------------------------------------- */
/*  Relations                                                                 */
/* -------------------------------------------------------------------------- */

export const businessesRelations = relations(businesses, ({ many, one }) => ({
  users: many(users),
  services: many(services),
  phoneNumbers: many(phoneNumbers),
  calls: many(calls),
  leads: many(leads),
  settings: one(businessSettings),
}));

export const callsRelations = relations(calls, ({ one, many }) => ({
  business: one(businesses, {
    fields: [calls.businessId],
    references: [businesses.id],
  }),
  events: many(callEvents),
  transcripts: many(transcripts),
  leads: many(leads),
  callbackRequests: many(callbackRequests),
}));

export const leadsRelations = relations(leads, ({ one, many }) => ({
  business: one(businesses, {
    fields: [leads.businessId],
    references: [businesses.id],
  }),
  call: one(calls, { fields: [leads.callId], references: [calls.id] }),
  notifications: many(notifications),
}));

export const callbackRequestsRelations = relations(callbackRequests, ({ one, many }) => ({
  call: one(calls, { fields: [callbackRequests.callId], references: [calls.id] }),
  notifications: many(notifications),
}));

export const notificationsRelations = relations(notifications, ({ one }) => ({
  lead: one(leads, { fields: [notifications.leadId], references: [leads.id] }),
  callbackRequest: one(callbackRequests, {
    fields: [notifications.callbackRequestId],
    references: [callbackRequests.id],
  }),
}));

/* -------------------------------------------------------------------------- */
/*  Inferred types                                                            */
/* -------------------------------------------------------------------------- */

export type BusinessRow = typeof businesses.$inferSelect;
export type UserRow = typeof users.$inferSelect;
export type BusinessSettingsRow = typeof businessSettings.$inferSelect;
export type ServiceRow = typeof services.$inferSelect;
export type PhoneNumberRow = typeof phoneNumbers.$inferSelect;
export type CallRow = typeof calls.$inferSelect;
export type CallEventRow = typeof callEvents.$inferSelect;
export type TranscriptRow = typeof transcripts.$inferSelect;
export type LeadRow = typeof leads.$inferSelect;
export type CallbackRequestRow = typeof callbackRequests.$inferSelect;
export type NotificationRow = typeof notifications.$inferSelect;
export type AuditLogRow = typeof auditLogs.$inferSelect;

export type NewCallRow = typeof calls.$inferInsert;
export type NewLeadRow = typeof leads.$inferInsert;
export type NewCallbackRequestRow = typeof callbackRequests.$inferInsert;
export type NewNotificationRow = typeof notifications.$inferInsert;

/** Every tenant-scoped table, used by the RLS verification test. */
export const TENANT_SCOPED_TABLES = [
  'users',
  'refresh_tokens',
  'business_settings',
  'services',
  'phone_numbers',
  'calls',
  'call_events',
  'transcripts',
  'leads',
  'callback_requests',
  'notifications',
  'audit_logs',
] as const;
