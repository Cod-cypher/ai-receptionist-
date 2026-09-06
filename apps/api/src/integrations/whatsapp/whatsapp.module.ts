/** Selects the WhatsApp provider from configuration. */

import { Global, Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { ConsoleWhatsAppProvider } from './console.provider';
import { TwilioWhatsAppProvider } from './twilio.provider';
import { WHATSAPP_PROVIDER, type WhatsAppProvider } from './whatsapp-provider.interface';

@Global()
@Module({
  providers: [
    {
      provide: WHATSAPP_PROVIDER,
      inject: [ConfigService],
      useFactory: (config: ConfigService): WhatsAppProvider => {
        const logger = new Logger('WhatsAppProvider');

        if (config.get<string>('WHATSAPP_PROVIDER') === 'twilio') {
          logger.log('Using Twilio WhatsApp');
          return new TwilioWhatsAppProvider(config);
        }

        logger.warn(
          'Using the console WhatsApp provider: notifications are logged, not sent.',
        );
        return new ConsoleWhatsAppProvider();
      },
    },
  ],
  exports: [WHATSAPP_PROVIDER],
})
export class WhatsAppModule {}
