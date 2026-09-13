/**
 * Twilio inbound voice webhooks — the `<Gather>` pipeline.
 *
 * The turn loop is a redirect cycle: Twilio POSTs the caller's speech to
 * `/turn`, we answer with TwiML that speaks the reply and opens another
 * `<Gather>` pointing back at `/turn`. Twilio performs the speech recognition
 * and the synthesis, so this path needs no vendor beyond Twilio itself, which
 * is what makes a real end-to-end call possible with two credentials.
 *
 * Everything below is transport plumbing. The conversation lives in
 * `CallSessionService` and the engine behind it, and neither knows this file
 * exists — the media-stream pipeline drives exactly the same calls.
 */

import {
  Body,
  Controller,
  Header,
  HttpCode,
  Logger,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { z } from 'zod';

import { CallSessionService, type TurnResult } from '../../../call-session/call-session.service';
import { BusinessConfigService } from '../../../modules/businesses/business-config.service';
import { Public } from '../../../common/decorators/public.decorator';
import { TwilioSignatureGuard } from './twilio-signature.guard';
import { escapeXml } from './twiml.builder';

/** Twilio's inbound voice webhook payload, narrowed to what is used. */
const VoiceWebhookSchema = z.object({
  CallSid: z.string().min(1),
  From: z.string().min(1),
  To: z.string().min(1),
});

const TurnWebhookSchema = z.object({
  CallSid: z.string().min(1),
  SpeechResult: z.string().optional(),
  Confidence: z.string().optional(),
});

const StatusWebhookSchema = z.object({
  CallSid: z.string().min(1),
  CallStatus: z.string().optional(),
  To: z.string().optional(),
});

const ContextSchema = z.object({
  businessId: z.string().uuid(),
  callId: z.string().uuid(),
});

@ApiExcludeController()
@Controller('telephony/twilio')
@UseGuards(TwilioSignatureGuard)
export class TwilioVoiceController {
  private readonly logger = new Logger('TwilioVoice');
  private readonly voice: string;
  private readonly baseUrl: string;
  private readonly pipeline: 'gather' | 'stream';

  constructor(
    private readonly callSession: CallSessionService,
    private readonly businessConfig: BusinessConfigService,
    config: ConfigService,
  ) {
    this.voice = config.get<string>('TWILIO_TTS_VOICE', 'Polly.Joanna');
    this.baseUrl = config.get<string>('PUBLIC_BASE_URL', 'http://localhost:3000');
    this.pipeline = config.get<'gather' | 'stream'>('VOICE_PIPELINE', 'gather');
  }

  /**
   * A call arrives. The dialled number is the only thing identifying the
   * tenant, so it is resolved first; an unrecognised number is answered
   * politely rather than dropped, because a misconfigured number is the
   * operator's problem and the caller should not hear a dead line.
   */
  @Public()
  @Post('voice')
  @HttpCode(200)
  @Header('Content-Type', 'text/xml')
  async voiceWebhook(@Body() body: unknown): Promise<string> {
    const payload = VoiceWebhookSchema.parse(body);

    const businessId = await this.businessConfig.findBusinessIdByPhoneNumber(payload.To);
    if (!businessId) {
      this.logger.error(
        `Inbound call to ${payload.To} matched no configured business. ` +
          'Add the number under the business settings to route it.',
      );
      return this.say(
        "Sorry, this number isn't set up to take calls right now. Please try again later.",
        { hangup: true },
      );
    }

    try {
      const result = await this.callSession.startCall({
        businessId,
        fromNumber: payload.From,
        toNumber: payload.To,
        provider: 'twilio',
        providerCallSid: payload.CallSid,
      });

      return this.turnToTwiml(businessId, result);
    } catch (error) {
      this.logger.error(
        `Failed to start call ${payload.CallSid}: ${
          error instanceof Error ? error.message : error
        }`,
      );
      return this.say(
        'Sorry, we are having a technical problem. Please call again shortly.',
        { hangup: true },
      );
    }
  }

  /** One conversational turn: the caller's speech comes back here. */
  @Public()
  @Post('turn')
  @HttpCode(200)
  @Header('Content-Type', 'text/xml')
  async turnWebhook(@Body() body: unknown, @Query() query: unknown): Promise<string> {
    const payload = TurnWebhookSchema.parse(body);
    const context = ContextSchema.parse(query);

    try {
      const speech = payload.SpeechResult?.trim() ?? '';

      // No SpeechResult means the gather timed out with nothing recognised —
      // silence, which the state machine handles differently from a
      // meaningless answer.
      const result = speech
        ? await this.callSession.handleUtterance(
            context.businessId,
            context.callId,
            speech,
            payload.Confidence,
          )
        : await this.callSession.handleEvent(context.businessId, context.callId, {
            kind: 'SILENCE',
          });

      return this.turnToTwiml(context.businessId, result);
    } catch (error) {
      this.logger.error(
        `Turn failed for call ${context.callId}: ${
          error instanceof Error ? error.message : error
        }`,
      );

      // Degrade to a callback rather than dropping the caller mid-sentence.
      await this.callSession
        .handleEvent(context.businessId, context.callId, {
          kind: 'PROVIDER_ERROR',
          message: error instanceof Error ? error.message : 'unknown',
        })
        .catch(() => undefined);

      return this.say(
        'Sorry, something went wrong on our end. Someone from the towing team will call you back.',
        { hangup: true },
      );
    }
  }

  /**
   * Call completion callback. Twilio sends this when the caller hangs up, which
   * is the signal to finalise a call that never reached a natural ending — and
   * the point at which a complete-but-unconfirmed intake still becomes a lead.
   */
  @Public()
  @Post('status')
  @HttpCode(204)
  async statusWebhook(@Body() body: unknown): Promise<void> {
    const payload = StatusWebhookSchema.parse(body);

    if (!['completed', 'failed', 'busy', 'no-answer', 'canceled'].includes(payload.CallStatus ?? '')) {
      return;
    }

    // This URL is set once on the phone number, so unlike the turn webhook it
    // cannot carry the tenant or call in its query string. Both are recovered
    // from what Twilio does send: the dialled number identifies the business,
    // and the CallSid identifies the call. An earlier version required them as
    // query parameters and so silently ignored every real hang-up.
    const businessId = payload.To
      ? await this.businessConfig.findBusinessIdByPhoneNumber(payload.To)
      : null;
    if (!businessId) {
      this.logger.warn(
        `Status callback for ${payload.CallSid} to ${payload.To ?? 'unknown number'} matched no business`,
      );
      return;
    }

    const callId = await this.callSession.findCallIdByProviderSid(businessId, payload.CallSid);
    if (!callId) {
      this.logger.warn(`Status callback for unknown call ${payload.CallSid}`);
      return;
    }

    await this.callSession
      .handleEvent(businessId, callId, { kind: 'HANGUP' })
      .catch((error) => {
        this.logger.warn(
          `Failed to finalise call ${callId}: ${
            error instanceof Error ? error.message : error
          }`,
        );
      });
  }

  /* ------------------------------------------------------------------------ */
  /*  TwiML                                                                   */
  /* ------------------------------------------------------------------------ */

  private turnToTwiml(businessId: string, result: TurnResult): string {
    if (result.ended) {
      return this.say(result.reply, { hangup: true });
    }

    // On the stream pipeline the greeting is the last thing this controller
    // says: the WebSocket takes over the conversation from here, and the
    // tenant and call travel to it as stream parameters.
    if (this.pipeline === 'stream') {
      const wsUrl = this.baseUrl.replace(/^http/, 'ws') + '/api/telephony/twilio/media';
      return [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<Response>',
        '  <Connect>',
        `    <Stream url="${escapeXml(wsUrl)}">`,
        `      <Parameter name="businessId" value="${escapeXml(businessId)}"/>`,
        `      <Parameter name="callId" value="${escapeXml(result.callId)}"/>`,
        // The greeting has already been generated and stored by startCall. It
        // travels to the gateway so it can be spoken in the same synthesised
        // voice as the rest of the call, rather than by Twilio's <Say>.
        `      <Parameter name="greeting" value="${escapeXml(result.reply)}"/>`,
        '    </Stream>',
        '  </Connect>',
        '</Response>',
      ].join('\n');
    }

    const action = `${this.baseUrl}/api/telephony/twilio/turn?businessId=${businessId}&callId=${result.callId}`;

    // bargeIn lets the caller interrupt the prompt, which is the closest this
    // pipeline gets to the media-stream path's true interruption.
    // speechTimeout=auto ends the gather when the caller stops talking rather
    // than after a fixed wait.
    return [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<Response>',
      `  <Gather input="speech" action="${escapeXml(action)}" method="POST"`,
      '          speechTimeout="auto" speechModel="phone_call" bargeIn="true"',
      '          language="en-US" actionOnEmptyResult="true">',
      `    <Say voice="${escapeXml(this.voice)}">${escapeXml(result.reply)}</Say>`,
      '  </Gather>',
      '</Response>',
    ].join('\n');
  }

  private say(text: string, options: { hangup?: boolean } = {}): string {
    const lines = ['<?xml version="1.0" encoding="UTF-8"?>', '<Response>'];
    if (text) {
      lines.push(`  <Say voice="${escapeXml(this.voice)}">${escapeXml(text)}</Say>`);
    }
    if (options.hangup) lines.push('  <Hangup/>');
    lines.push('</Response>');
    return lines.join('\n');
  }
}
