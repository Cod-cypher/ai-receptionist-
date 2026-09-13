/**
 * Text-mode call simulator.
 *
 * Drives the identical path a phone call takes — same engine, same state
 * machine, same persistence, same lead creation, same WhatsApp notification —
 * with the telephony layer replaced by HTTP. It exists because the pipeline
 * that matters (call to lead to operator's phone) should be demonstrable and
 * testable without a Twilio account, a phone number, or a tunnel.
 *
 * Unauthenticated, so it is gated behind `ENABLE_DEV_SIMULATOR` and the config
 * schema refuses to boot with it enabled in production.
 */

import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { inArray, or } from 'drizzle-orm';
import { ApiExcludeController } from '@nestjs/swagger';
import { z } from 'zod';

import { CallSessionService } from '../../call-session/call-session.service';
import { DatabaseService } from '../../database/database.module';
import { notifications } from '../../database/schema';
import { BusinessConfigService } from '../businesses/business-config.service';
import { CallsService } from '../calls/calls.service';

const StartSchema = z.object({
  /** Either identifies the tenant directly, or routes by the dialled number. */
  businessId: z.string().uuid().optional(),
  toNumber: z.string().optional(),
  fromNumber: z.string().default('+923001234567'),
});

const TurnSchema = z.object({
  businessId: z.string().uuid(),
  callId: z.string().uuid(),
  /** Omit or send empty to simulate silence. */
  text: z.string().default(''),
});

const EventSchema = z.object({
  businessId: z.string().uuid(),
  callId: z.string().uuid(),
  event: z.enum(['SILENCE', 'HANGUP', 'MAX_DURATION']),
});

@ApiExcludeController()
@Controller('dev/conversations')
export class DevSimulatorController {
  constructor(
    private readonly callSession: CallSessionService,
    private readonly businessConfig: BusinessConfigService,
    private readonly calls: CallsService,
    private readonly database: DatabaseService,
  ) {}

  @Post()
  async start(@Body() body: unknown) {
    const input = StartSchema.parse(body);

    const businessId =
      input.businessId ??
      (input.toNumber
        ? await this.businessConfig.findBusinessIdByPhoneNumber(input.toNumber)
        : null);

    if (!businessId) {
      throw new BadRequestException(
        'Provide businessId, or a toNumber that maps to a configured phone number.',
      );
    }

    const result = await this.callSession.startCall({
      businessId,
      fromNumber: input.fromNumber,
      toNumber: input.toNumber ?? 'simulator',
      provider: 'simulator',
      providerCallSid: `sim-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    });

    // A phone call carries its tenant in the webhook URL; the simulator's
    // caller has to be told it, since every later turn needs it.
    return { ...result, businessId };
  }

  @Post('turn')
  async turn(@Body() body: unknown) {
    const input = TurnSchema.parse(body);
    return this.callSession.handleUtterance(input.businessId, input.callId, input.text);
  }

  /**
   * What the call produced: transcript, extracted fields, lead, and the exact
   * WhatsApp message the operator would receive. Lets the simulator show the
   * end result without the tester having to log in to the dashboard.
   */
  @Get(':callId')
  async result(@Param('callId') callId: string, @Query('businessId') businessId: string) {
    const ids = z
      .object({ callId: z.string().uuid(), businessId: z.string().uuid() })
      .parse({ callId, businessId });

    const detail = await this.calls.findOneDetailed(ids.businessId, ids.callId);

    const subjectIds = [
      ...(detail.lead ? [detail.lead.id] : []),
      ...detail.callbackRequests.map((c) => c.id),
    ];

    const messages =
      subjectIds.length === 0
        ? []
        : await this.database.withTenant(ids.businessId, (tx) =>
            tx
              .select({
                status: notifications.status,
                target: notifications.target,
                payload: notifications.payload,
              })
              .from(notifications)
              .where(
                or(
                  inArray(notifications.leadId, subjectIds),
                  inArray(notifications.callbackRequestId, subjectIds),
                ),
              ),
          );

    return { ...detail, notifications: messages };
  }

  @Post('event')
  async event(@Body() body: unknown) {
    const input = EventSchema.parse(body);
    return this.callSession.handleEvent(input.businessId, input.callId, {
      kind: input.event,
    } as never);
  }
}
