import { Module } from '@nestjs/common';

import { TwilioVoiceController } from './twilio/twilio-voice.controller';
import { TwilioSignatureGuard } from './twilio/twilio-signature.guard';
import { MediaStreamGateway } from './twilio/media-stream.gateway';
import { BusinessesModule } from '../../modules/businesses/businesses.module';
import { SttModule } from '../stt/stt.module';
import { TtsModule } from '../tts/tts.module';

/**
 * Telephony transport.
 *
 * Both pipelines are registered; VOICE_PIPELINE decides which TwiML the voice
 * webhook returns, and `main.ts` only attaches the WebSocket gateway when the
 * stream pipeline is selected. Neither is visible to the conversation engine.
 */
@Module({
  imports: [BusinessesModule, SttModule, TtsModule],
  controllers: [TwilioVoiceController],
  providers: [TwilioSignatureGuard, MediaStreamGateway],
  exports: [MediaStreamGateway],
})
export class TelephonyModule {}
