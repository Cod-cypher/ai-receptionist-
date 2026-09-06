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
  Post,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { z } from 'zod';

import { CallSessionService } from '../../call-session/call-session.service';
import { BusinessConfigService } from '../businesses/business-config.service';

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

    return this.callSession.startCall({
      businessId,
      fromNumber: input.fromNumber,
      toNumber: input.toNumber ?? 'simulator',
      provider: 'simulator',
      providerCallSid: `sim-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    });
  }

  @Post('turn')
  async turn(@Body() body: unknown) {
    const input = TurnSchema.parse(body);
    return this.callSession.handleUtterance(input.businessId, input.callId, input.text);
  }

  @Post('event')
  async event(@Body() body: unknown) {
    const input = EventSchema.parse(body);
    return this.callSession.handleEvent(input.businessId, input.callId, {
      kind: input.event,
    } as never);
  }
}
