/**
 * Twilio WhatsApp delivery.
 *
 * Two sending modes, because WhatsApp itself has two:
 *
 * - With `TWILIO_WHATSAPP_CONTENT_SID` set, the message goes out as an approved
 *   content template with positional variables. This is what production needs:
 *   a lead notification is business-initiated, and WhatsApp only permits
 *   business-initiated messages outside the 24-hour service window if they use
 *   an approved template.
 * - Without it, a plain body is sent. That works in the Twilio sandbox and
 *   inside an open service window, which is enough to develop against.
 *
 * Either way the content comes from the same rendered lead, so the two modes
 * cannot say different things.
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import twilio, { type Twilio } from 'twilio';

import {
  WhatsAppSendError,
  type WhatsAppMessage,
  type WhatsAppProvider,
  type WhatsAppSendResult,
} from './whatsapp-provider.interface';

/**
 * Twilio error codes that will never succeed on retry: a bad number or an
 * unreachable recipient does not become valid by waiting.
 */
const PERMANENT_ERROR_CODES = new Set([
  21211, // invalid 'To' number
  21408, // permission to send to this region not enabled
  21610, // recipient has unsubscribed
  21614, // 'To' number is not a valid mobile number
  63003, // channel could not find the 'To' address
  63016, // failed to send freeform message outside the service window
]);

@Injectable()
export class TwilioWhatsAppProvider implements WhatsAppProvider {
  readonly name = 'twilio';
  private readonly logger = new Logger('WhatsApp');
  private readonly client: Twilio;
  private readonly from: string;
  private readonly contentSid: string | undefined;

  constructor(config: ConfigService) {
    this.client = twilio(
      config.getOrThrow<string>('TWILIO_ACCOUNT_SID'),
      config.getOrThrow<string>('TWILIO_AUTH_TOKEN'),
    );
    this.from = config.getOrThrow<string>('TWILIO_WHATSAPP_FROM');
    this.contentSid = config.get<string>('TWILIO_WHATSAPP_CONTENT_SID') || undefined;

    if (!this.contentSid) {
      this.logger.warn(
        'TWILIO_WHATSAPP_CONTENT_SID is not set. Messages will be sent as plain ' +
          'bodies, which WhatsApp only accepts in the sandbox or inside a ' +
          '24-hour service window. Configure an approved template for production.',
      );
    }
  }

  async send(message: WhatsAppMessage): Promise<WhatsAppSendResult> {
    const to = message.to.startsWith('whatsapp:') ? message.to : `whatsapp:${message.to}`;

    try {
      const sent = await this.client.messages.create({
        from: this.from.startsWith('whatsapp:') ? this.from : `whatsapp:${this.from}`,
        to,
        ...(this.contentSid && message.templateVariables
          ? {
              contentSid: this.contentSid,
              contentVariables: JSON.stringify(message.templateVariables),
            }
          : { body: message.body }),
      });

      return { providerMessageId: sent.sid };
    } catch (error) {
      const code = (error as { code?: number }).code;
      const status = (error as { status?: number }).status;

      // 4xx other than rate limiting means the request itself is wrong.
      const permanent =
        (code !== undefined && PERMANENT_ERROR_CODES.has(code)) ||
        (status !== undefined && status >= 400 && status < 500 && status !== 429);

      throw new WhatsAppSendError(
        `Twilio WhatsApp send failed${code ? ` (code ${code})` : ''}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        !permanent,
        error,
      );
    }
  }
}
