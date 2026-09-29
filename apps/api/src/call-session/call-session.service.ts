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

import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, asc, desc, eq } from 'drizzle-orm';
import {
  CallEventType,
  CallOutcome,
  buildLeadFromSlots,
  type CallOutcome as CallOutcomeType,
  type Lead,
} from '@towai/shared';

import {
  ConversationEngine,
  type EngineTurnResult,
} from '../conversation/conversation-engine';
import { applyIntake, type IntakeOperation } from '../conversation/intake';
import { judgeFor } from '../conversation/judge-for';
import { buildLeadNotes } from '../conversation/lead-notes';
import type { NextActionPlan } from '../conversation/next-action';
import { FALLBACK_EMERGENCY_NUMBER, regionForNumber } from '../conversation/region';
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
import { CALL_JUDGE, type CallJudge } from '../integrations/judgment/judgment.interface';
import { NoopJudge } from '../integrations/judgment/noop.judge';
import { ANSWERED_FLOOR, MOVE_CONFIDENCE_FLOOR } from '../integrations/judgment/typesafe-questions';
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

export interface IntakeOperationResult {
  /** Facts for the realtime model: the tool result. */
  output: Record<string, unknown>;
  ended: boolean;
  outcome: CallOutcomeType | null;
  /** What the receptionist must do next; null once the call is over. */
  plan: NextActionPlan | null;
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
    @Inject(CALL_JUDGE) private readonly judge: CallJudge,
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
   * One operation from the realtime receptionist: a detail it heard, a question
   * about the business, a request to complete or end the call, or a line of
   * caller speech. The business and call come from the live session, never from
   * the model. Validation and every rule stay here; the result is facts for the
   * model to use, plus whether the call is now over.
   */
  async applyIntakeOperation(
    businessId: string,
    callId: string,
    op: IntakeOperation,
    /**
     * `judge: false` applies the operation by the rules alone, at once. For a
     * caller line on a live call, which is judged beside the call instead
     * (see `judgeCallerLine`) so that no reply waits for the judge.
     */
    meta: { callerTurn?: number; judge?: boolean } = {},
  ): Promise<IntakeOperationResult> {
    const { config, call, context, turns } = await this.loadSession(businessId, callId);

    if (call.status !== 'in_progress') {
      // A caller's last words are often transcribed after the lead was created
      // and the call closed. They still belong in the transcript.
      if (op.kind === 'caller_speech') await this.appendTranscriptLine(businessId, callId, 'customer', op.text);
      return {
        output: { callEnded: true, note: 'This call has already been completed.' },
        ended: true,
        outcome: (call.outcome as CallOutcomeType | null) ?? null,
        plan: null,
      };
    }

    // The caller's own country decides how a local number they say is read and
    // which emergency number they are given; the business may be set up for
    // another country.
    const region = regionForNumber(call.fromNumber);
    const defaultRegionPrefix = region?.prefix ?? config.defaultRegionPrefix;
    const knownAreas = config.flow.facts.serviceAreas;
    // Jev reads the location about to be saved, or the line just spoken,
    // before the engine decides. With no judgment the rules decide alone.
    const judgments = meta.judge === false ? {} : await judgeFor(this.judge, context, op, { knownAreas, defaultRegionPrefix });
    const result = applyIntake(context, op, config.flow, {
      defaultRegionPrefix,
      callerTurn: meta.callerTurn,
      emergencyNumber: region?.emergencyNumber ?? FALLBACK_EMERGENCY_NUMBER,
      knownAreas,
      judgments,
    });

    const turn = await this.commitTurn(
      config,
      call,
      { context: result.context, effects: result.effects, reply: '' },
      turns,
      op.kind === 'caller_speech' ? { speaker: 'customer', text: op.text } : undefined,
    );

    return { output: result.output, ended: result.ended || turn.ended, outcome: turn.outcome, plan: result.plan };
  }

  /**
   * What the judge makes of a line the caller spoke, as the operation that
   * folds it into the call. Reads the call and changes nothing: the caller of
   * this applies the operation in the call's own order. Null when there is no
   * judge, no judgment, or the call is over. Never throws.
   */
  async judgeCallerLine(businessId: string, callId: string, text: string): Promise<IntakeOperation | null> {
    if (this.judge instanceof NoopJudge) return null;
    try {
      const { config, call, context } = await this.loadSession(businessId, callId);
      if (call.status !== 'in_progress') return null;
      const judgments = await judgeFor(this.judge, context, { kind: 'caller_speech', text }, { knownAreas: config.flow.facts.serviceAreas });
      return Object.keys(judgments).length > 0 ? { kind: 'judgment', text, judgments } : null;
    } catch (error) {
      this.logger.warn(`Call ${callId}: could not judge a caller line: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  /**
   * Whether what the receptionist said on `callerTurn` answered the caller,
   * as the operation that folds it into the call. Asked only when the
   * caller's line on that turn was a question, a complaint or a check of the
   * line, and has not been found answered already. Reads the call and changes
   * nothing. Null when there is nothing to judge. Never throws.
   */
  async judgeReply(businessId: string, callId: string, reply: string, callerTurn: number): Promise<IntakeOperation | null> {
    if (this.judge instanceof NoopJudge) return null;
    try {
      const { call, context } = await this.loadSession(businessId, callId);
      if (call.status !== 'in_progress') return null;
      const said = context.judgments?.move;
      if (!said || said.callerTurn !== callerTurn || said.confidence < MOVE_CONFIDENCE_FLOOR) return null;
      if (said.move !== 'question' && said.move !== 'complaint' && said.move !== 'line_check') return null;
      if (said.answered !== undefined && said.answered >= ANSWERED_FLOOR) return null;

      const judgments = await this.judge.judgeReply(said.text, reply);
      return judgments ? { kind: 'judgment', text: said.text, judgments } : null;
    } catch (error) {
      this.logger.warn(`Call ${callId}: could not judge a reply: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
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

  /** A line the receptionist actually spoke, recorded as it happened. */
  async appendAiTranscriptLine(businessId: string, callId: string, text: string): Promise<void> {
    await this.appendTranscriptLine(businessId, callId, 'ai', text);
  }

  private async appendTranscriptLine(
    businessId: string,
    callId: string,
    speaker: 'ai' | 'customer',
    text: string,
  ): Promise<void> {
    const spoken = text.trim();
    if (!spoken) return;

    await this.database.withTenant(businessId, async (tx) => {
      const rows = await tx
        .select({ turnIndex: transcripts.turnIndex })
        .from(transcripts)
        .where(eq(transcripts.callId, callId))
        .orderBy(desc(transcripts.turnIndex))
        .limit(1);
      await this.appendTranscript(tx, businessId, callId, (rows[0]?.turnIndex ?? -1) + 1, speaker, spoken);
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
    result: Pick<EngineTurnResult, 'context' | 'effects' | 'reply'>,
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
    result: Pick<EngineTurnResult, 'context' | 'effects'>,
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
            priority: result.context.urgency?.level ?? 'normal',
            fieldSources: result.context.fieldSources ?? {},
            additionalNotes: buildLeadNotes(result.context),
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
      priority: row.priority,
      fieldSources: row.fieldSources,
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
