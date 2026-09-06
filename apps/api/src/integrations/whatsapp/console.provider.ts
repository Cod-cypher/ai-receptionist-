/**
 * Development WhatsApp provider: logs the message instead of sending it.
 *
 * It runs the identical rendering and queue path as the real provider, so a
 * developer with no Twilio account still exercises lead creation, the
 * notification row, and the retry machinery — everything except the network hop.
 */

import { Injectable, Logger } from '@nestjs/common';
import type {
  WhatsAppMessage,
  WhatsAppProvider,
  WhatsAppSendResult,
} from './whatsapp-provider.interface';

@Injectable()
export class ConsoleWhatsAppProvider implements WhatsAppProvider {
  readonly name = 'console';
  private readonly logger = new Logger('WhatsApp');

  async send(message: WhatsAppMessage): Promise<WhatsAppSendResult> {
    this.logger.log(
      `\n--- WhatsApp to ${message.to} ---\n${message.body}\n--- end ---`,
    );
    return { providerMessageId: `console-${Date.now()}` };
  }
}
