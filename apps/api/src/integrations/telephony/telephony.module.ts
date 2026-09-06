import { Module } from '@nestjs/common';

import { TwilioVoiceController } from './twilio/twilio-voice.controller';
import { TwilioSignatureGuard } from './twilio/twilio-signature.guard';
import { BusinessesModule } from '../../modules/businesses/businesses.module';

/**
 * Telephony transport.
 *
 * Only the Twilio `<Gather>` pipeline is wired here. The media-stream pipeline
 * lives behind the same `CallSessionService` calls, so adding it does not touch
 * the conversation engine — see docs/telephony-setup.md.
 */
@Module({
  imports: [BusinessesModule],
  controllers: [TwilioVoiceController],
  providers: [TwilioSignatureGuard],
})
export class TelephonyModule {}
