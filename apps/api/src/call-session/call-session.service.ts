/**
 * Call orchestration: the bridge between the pure conversation engine and the
 * database.
 *
 * The engine decides and returns `Effect[]`; this executes them. Keeping the
 * two apart is what lets a phone call, the text simulator and the test suite
 * drive identical logic — none of them appear anywhere in the engine.
 *
 * It is transport-agnostic on purpose. Twilio's `<Gather>` loop and the media
 * stream gateway both call `startCall` / `handleUtterance` / `endCall` and
 * neither is visible from here.
 */

import { Injectable, Logger } from '@nestjs/common';
import { and, asc, desc, eq } from 'drizzle-orm';
import {
  CallEventType,
  CallOutcome,
  buildLeadFromSlots,
  type CallOutcome as CallOutcomeType,
  type ExtractionResult,
  type Lead,
} from '@towai/shared';

import {
  ConversationEngine,
  currentRequirementId,
  type EngineTurnResult,
} from '../conversation/conversation-engine';
import type { ExtractionPromptInput } from '../conversation/prompt-builder';
import { initialContext, type ConversationContext, type Effect, type TurnInput } from '../conversation/types';
import { DatabaseService, type TenantDatabase } from '../database/database.module';
import {
  callEvents,
  callbackRequests,
  calls,
  leads,
  transcripts,
  type CallRow,
} from '../database/schema';
import { BusinessConfigService, type ReceptionistConfig } from '../modules/businesses/business-config.service';
import { NotificationsService } from '../modules/notifications/notifications.service';
import type { TranscriptTurn } from '../integrations/ai/ai-provider.interface';
import { CallSessionStore } from './call-session.store';

export interface StartCallInput {
  businessId: string;
  fromNumber: string;
  toNumber: string;
  provider?: string;
  providerCallSid?: string;
  /** False when a speech-to-speech model voices the reply itself. */
  phrase?: boolean;
}

export interface TurnResult {
  callId: string;
  /** What to say. Empty means the call is over and nothing more is spoken. */
  reply: string;
  ended: boolean;
  state: string;
  outcome: CallOutcomeType | null;
}

@Injectable()
export class CallSessionService {
  private readonly logger = new Logger(CallSessionService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly businessConfig: BusinessConfigService,
    private readonly engine: ConversationEngine,
    private readonly notifications: NotificationsService,
    private readonly store: CallSessionStore,
  ) {}

  /* ------------------------------------------------------------------------ */
  /*  Lifecycle                                                               */
  /* ------------------------------------------------------------------------ */

  async startCall(input: StartCallInput): Promise<TurnResult> {
    const config = await this.businessConfig.load(input.businessId);

    const call = await this.database.withTenant(input.businessId, async (tx) => {
      const [row] = await tx
        .insert(calls)
        .values({
          businessId: input.businessId,
          provider: input.provider ?? 'twilio',
          providerCallSid: input.providerCallSid ?? null,
          fromNumber: input.fromNumber,
          toNumber: input.toNumber,
          direction: 'inbound',
          status: 'in_progress',
        })
        .returning();
      return row!;
    });

    // The caller ID seeds the phone slot. It still needs confirming — the state
    // machine tracks that separately — but it means the receptionist asks "is
    // this the best number?" instead of "what is your number?".
    const context = initialContext({ customerPhone: input.fromNumber });

    await this.recordEvent(input.businessId, call.id, CallEventType.CALL_STARTED, {
      from: input.fromNumber,
      to: input.toNumber,
      provider: input.provider ?? 'twilio',
    });

    const result = await this.engine.begin(context, {
      config: config.flow,
      recentTurns: [],
      defaultRegionPrefix: config.defaultRegionPrefix,
      phrase: input.phrase,
    });

    return this.commitTurn(config, call, result, []);
  }

  /**
   * One caller turn already understood by a speech-to-speech model: what it
   * heard, and the fields it extracted. Validation and every decision still
   * happen here, exactly as for a transcribed utterance.
   */
  async handleExtractedTurn(
    businessId: string,
    callId: string,
    heard: string,
    extraction: ExtractionResult,
  ): Promise<TurnResult> {
    const { config, call, context, turns } = await this.loadSession(businessId, callId);

    if (call.status !== 'in_progress') {
      return this.terminalResult(call);
    }

    const result = await this.engine.handleExtraction(context, heard, extraction, {
      config: config.flow,
      recentTurns: turns,
      defaultRegionPrefix: config.defaultRegionPrefix,
      phrase: false,
    });

    return this.commitTurn(config, call, result, turns, {
      speaker: 'customer',
      text: heard || '(unclear)',
    });
  }

  /**
   * What a listener needs to interpret the caller's next turn: the business,
   * what is already known, and what the receptionist last asked about.
   */
  async extractionContext(businessId: string, callId: string): Promise<ExtractionPromptInput> {
    const { config, context, turns } = await this.loadSession(businessId, callId);
    return {
      facts: config.flow.facts,
      filledSlots: context.values,
      pendingRequirement: currentRequirementId(context),
      recentTurns: turns,
    };
  }

  /** Records a call event raised outside a turn, e.g. by a voice gateway. */
  async logCallEvent(
    businessId: string,
    callId: string,
    type: CallEventType,
    payload?: Record<string, unknown>,
  ): Promise<void> {
    await this.recordEvent(businessId, callId, type, payload);
  }

  /**
   * Replaces the stored text of the receptionist's latest line with what was
   * actually spoken. A speech-to-speech model may smooth a line's wording, and
   * the transcript should show what the caller heard.
   */
  async replaceLastAiTranscript(businessId: string, callId: string, text: string): Promise<void> {
    const spoken = text.trim();
    if (!spoken) return;

    await this.database.withTenant(businessId, async (tx) => {
      const [latest] = await tx
        .select({ id: transcripts.id })
        .from(transcripts)
        .where(and(eq(transcripts.callId, callId), eq(transcripts.speaker, 'ai')))
        .orderBy(desc(transcripts.turnIndex))
        .limit(1);

      if (latest) {
        await tx.update(transcripts).set({ text: spoken }).where(eq(transcripts.id, latest.id));
      }
    });
  }

  /** One caller utterance. */
  async handleUtterance(
    businessId: string,
    callId: string,
    transcript: string,
    confidence?: string,
  ): Promise<TurnResult> {
    const { config, call, context, turns } = await this.loadSession(businessId, callId);

    if (call.status !== 'in_progress') {
      return this.terminalResult(call);
    }

    const result = await this.engine.handleUtterance(context, transcript, {
      config: config.flow,
      recentTurns: turns,
      defaultRegionPrefix: config.defaultRegionPrefix,
    });

    return this.commitTurn(config, call, result, turns, {
      speaker: 'customer',
      text: transcript,
      confidence,
    });
  }

  /**
   * The call a telephony provider's own id refers to, within one tenant.
   * Needed for callbacks, such as Twilio's call status, whose URL is fixed per
   * phone number and so cannot carry our call id.
   */
  async findCallIdByProviderSid(
    businessId: string,
    providerCallSid: string,
  ): Promise<string | null> {
    const rows = await this.database.withTenant(businessId, (tx) =>
      tx
        .select({ id: calls.id })
        .from(calls)
        .where(and(eq(calls.businessId, businessId), eq(calls.providerCallSid, providerCallSid)))
        .limit(1),
    );
    return rows[0]?.id ?? null;
  }

  /** Silence, hang-up, timeout — anything that is not speech. */
  async handleEvent(
    businessId: string,
    callId: string,
    input: Exclude<TurnInput, { kind: 'UTTERANCE' }>,
    options: { phrase?: boolean } = {},
  ): Promise<TurnResult> {
    const { config, call, context, turns } = await this.loadSession(businessId, callId);

    if (call.status !== 'in_progress') {
      return this.terminalResult(call);
    }

    const result = await this.engine.handleEvent(context, input, {
      config: config.flow,
      recentTurns: turns,
      defaultRegionPrefix: config.defaultRegionPrefix,
      phrase: options.phrase,
    });

    return this.commitTurn(config, call, result, turns);
  }

  /* ------------------------------------------------------------------------ */
  /*  Persistence                                                             */
  /* ------------------------------------------------------------------------ */

  /**
   * Persist one turn and run its effects.
   *
   * Transcript, events, and any lead or callback go in a single transaction, so
   * a crash mid-turn cannot leave a lead without the call it came from. Delivery
   * of the WhatsApp notification happens *after* the commit — see
   * `NotificationsService` for why that ordering is the whole guarantee.
   */
  private async commitTurn(
    config: ReceptionistConfig,
    call: CallRow,
    result: EngineTurnResult,
    priorTurns: TranscriptTurn[],
    customerTurn?: { speaker: 'customer'; text: string; confidence?: string },
  ): Promise<TurnResult> {
    const businessId = call.businessId;
    let notificationIds: string[] = [];
    let createdLead: Lead | null = null;

    await this.database.withTenant(businessId, async (tx) => {
      let turnIndex = priorTurns.length;

      if (customerTurn) {
        await this.appendTranscript(tx, businessId, call.id, turnIndex++, 'customer', customerTurn.text, customerTurn.confidence);
      }
      if (result.reply) {
        await this.appendTranscript(tx, businessId, call.id, turnIndex++, 'ai', result.reply);
      }

      const outcome = await this.applyEffects(tx, config, call, result, {
        onLead: (lead) => {
          createdLead = lead;
        },
        onNotification: (id) => notificationIds.push(id),
      });

      await tx
        .update(calls)
        .set({
          finalState: result.context.state,
          collectedData: result.context.values as Record<string, unknown>,
          ...(outcome
            ? {
                outcome,
                status: 'completed' as const,
                endedAt: new Date(),
                durationSeconds: Math.max(
                  0,
                  Math.round((Date.now() - call.startedAt.getTime()) / 1000),
                ),
              }
            : {}),
        })
        .where(eq(calls.id, call.id));
    });

    await this.store.save(call.id, result.context);

    // Fire and forget: the sweeper will retry anything that fails, so a slow
    // WhatsApp API must not hold up the caller's next question.
    for (const id of notificationIds) {
      const variables =
        createdLead && config.whatsappNumber
          ? this.notifications.buildTemplateVariables(
              createdLead,
              config.business.name,
              config.business.timezone,
            )
          : undefined;

      void this.notifications.deliver(businessId, id, variables).catch((error) => {
        this.logger.warn(
          `Immediate notification delivery failed for ${id}; leaving it to the sweeper: ${
            error instanceof Error ? error.message : error
          }`,
        );
      });
    }

    const ended = result.context.state === 'ENDED';

    return {
      callId: call.id,
      reply: result.reply,
      ended,
      state: result.context.state,
      outcome: ended ? this.outcomeFromEffects(result.effects) : null,
    };
  }

  /**
   * Execute the engine's effects.
   * Returns the call outcome when the call is finishing, otherwise null.
   */
  private async applyEffects(
    tx: TenantDatabase,
    config: ReceptionistConfig,
    call: CallRow,
    result: EngineTurnResult,
    hooks: {
      onLead: (lead: Lead) => void;
      onNotification: (id: string) => void;
    },
  ): Promise<CallOutcomeType | null> {
    const businessId = call.businessId;
    let outcome: CallOutcomeType | null = null;
    let sequence = await this.nextSequence(tx, call.id);

    // Events raised while handling an effect are appended after the effect's
    // own event, so the trail reads in the order things actually happened
    // (LEAD_CREATED then WHATSAPP_QUEUED, not the reverse).
    const deferredEvents: Array<{ type: string; payload: Record<string, unknown> }> = [];

    for (const effect of result.effects) {
      switch (effect.type) {
        case 'LOG_EVENT':
          await tx.insert(callEvents).values({
            businessId,
            callId: call.id,
            type: effect.event,
            sequence: sequence++,
            payload: effect.payload ?? null,
          });
          break;

        case 'CREATE_LEAD': {
          const payload = buildLeadFromSlots({
            businessId,
            callId: call.id,
            values: result.context.values,
          });

          const [row] = await tx.insert(leads).values(payload).returning();
          const lead = this.toLead(row!);
          hooks.onLead(lead);

          if (config.whatsappNumber) {
            const notification = await this.notifications.createLeadNotification(tx, {
              businessId,
              lead,
              businessName: config.business.name,
              timezone: config.business.timezone,
              whatsappNumber: config.whatsappNumber,
            });
            hooks.onNotification(notification.id);
            deferredEvents.push({
              type: CallEventType.WHATSAPP_QUEUED,
              payload: { notificationId: notification.id },
            });
          } else {
            // The lead is safe either way; the operator just will not be paged.
            this.logger.warn(
              `Business ${businessId} has no WhatsApp number configured; lead ${lead.id} saved without notification`,
            );
          }
          break;
        }

        case 'CREATE_CALLBACK': {
          const transcriptText = await this.renderTranscript(tx, call.id);

          const [row] = await tx
            .insert(callbackRequests)
            .values({
              businessId,
              callId: call.id,
              customerName: result.context.values.customerName ?? null,
              customerPhone: result.context.values.customerPhone ?? call.fromNumber,
              reason: effect.reason,
              transcriptSnapshot: transcriptText,
            })
            .returning();

          if (config.whatsappNumber) {
            const notification = await this.notifications.createCallbackNotification(tx, {
              businessId,
              callbackRequestId: row!.id,
              customerName: row!.customerName,
              customerPhone: row!.customerPhone,
              reason: row!.reason,
              createdAt: row!.createdAt,
              businessName: config.business.name,
              timezone: config.business.timezone,
              whatsappNumber: config.whatsappNumber,
            });
            hooks.onNotification(notification.id);
          }
          break;
        }

        case 'END_CALL':
          outcome = effect.outcome;
          break;
      }
    }

    for (const event of deferredEvents) {
      await tx.insert(callEvents).values({
        businessId,
        callId: call.id,
        type: event.type,
        sequence: sequence++,
        payload: event.payload,
      });
    }

    return outcome;
  }

  /* ------------------------------------------------------------------------ */
  /*  Helpers                                                                 */
  /* ------------------------------------------------------------------------ */

  private async loadSession(businessId: string, callId: string) {
    const config = await this.businessConfig.load(businessId);

    const { call, turns } = await this.database.withTenant(businessId, async (tx) => {
      const [callRow] = await tx.select().from(calls).where(eq(calls.id, callId)).limit(1);
      if (!callRow) throw new Error(`Call ${callId} not found for business ${businessId}`);

      const rows = await tx
        .select({ speaker: transcripts.speaker, text: transcripts.text })
        .from(transcripts)
        .where(eq(transcripts.callId, callId))
        .orderBy(asc(transcripts.turnIndex));

      return {
        call: callRow,
        turns: rows
          .filter((r) => r.speaker !== 'system')
          .map((r) => ({ speaker: r.speaker as 'ai' | 'customer', text: r.text })),
      };
    });

    // Redis holds the live context; the database holds the audit trail. On a
    // cache miss the context is rebuilt from what was collected so far, so a
    // restart mid-call costs conversational nuance but not the caller's answers.
    const context =
      (await this.store.load(callId)) ??
      this.rebuildContext(call);

    return { config, call, context, turns };
  }

  private rebuildContext(call: CallRow): ConversationContext {
    const values = (call.collectedData ?? {}) as ConversationContext['values'];
    return {
      ...initialContext(values),
      state: (call.finalState as ConversationContext['state']) ?? 'GREETING',
    };
  }

  private async appendTranscript(
    tx: TenantDatabase,
    businessId: string,
    callId: string,
    turnIndex: number,
    speaker: 'ai' | 'customer' | 'system',
    text: string,
    confidence?: string,
  ): Promise<void> {
    await tx
      .insert(transcripts)
      .values({
        businessId,
        callId,
        turnIndex,
        speaker,
        text,
        confidence: confidence ?? null,
      })
      // A retried webhook must not blow up the call on a unique-index clash.
      .onConflictDoNothing();
  }

  private async nextSequence(tx: TenantDatabase, callId: string): Promise<number> {
    const rows = await tx
      .select({ sequence: callEvents.sequence })
      .from(callEvents)
      .where(eq(callEvents.callId, callId));
    return rows.reduce((max, r) => Math.max(max, r.sequence), -1) + 1;
  }

  private async renderTranscript(tx: TenantDatabase, callId: string): Promise<string> {
    const rows = await tx
      .select({ speaker: transcripts.speaker, text: transcripts.text })
      .from(transcripts)
      .where(eq(transcripts.callId, callId))
      .orderBy(asc(transcripts.turnIndex));

    return rows
      .map((r) => `${r.speaker === 'ai' ? 'Receptionist' : 'Caller'}: ${r.text}`)
      .join('\n');
  }

  private outcomeFromEffects(effects: Effect[]): CallOutcomeType | null {
    for (const effect of effects) {
      if (effect.type === 'END_CALL') return effect.outcome;
    }
    return null;
  }

  private terminalResult(call: CallRow): TurnResult {
    return {
      callId: call.id,
      reply: '',
      ended: true,
      state: call.finalState ?? 'ENDED',
      outcome: (call.outcome as CallOutcomeType | null) ?? CallOutcome.ABANDONED,
    };
  }

  private toLead(row: typeof leads.$inferSelect): Lead {
    return {
      id: row.id,
      businessId: row.businessId,
      callId: row.callId,
      customerName: row.customerName,
      customerPhone: row.customerPhone,
      service: row.service,
      location: row.location,
      destination: row.destination,
      vehicleMake: row.vehicleMake,
      vehicleModel: row.vehicleModel,
      vehicleType: row.vehicleType,
      vehicleCondition: row.vehicleCondition,
      vehicleMovable: row.vehicleMovable,
      additionalNotes: row.additionalNotes,
      source: 'ai_receptionist',
      status: row.status,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private async recordEvent(
    businessId: string,
    callId: string,
    type: CallEventType,
    payload?: Record<string, unknown>,
  ): Promise<void> {
    await this.database.withTenant(businessId, async (tx) => {
      const sequence = await this.nextSequence(tx, callId);
      await tx.insert(callEvents).values({
        businessId,
        callId,
        type,
        sequence,
        payload: payload ?? null,
      });
    });
  }
}
