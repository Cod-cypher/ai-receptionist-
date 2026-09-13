import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';

import { AppModule } from './app.module';
import { MediaStreamGateway } from './integrations/telephony/twilio/media-stream.gateway';
import { RealtimeVoiceGateway } from './integrations/telephony/twilio/realtime-voice.gateway';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, {
    // Twilio signs the raw body; Express must not have consumed it first.
    rawBody: true,
  });

  const logger = new Logger('Bootstrap');

  app.use(helmet());
  app.enableCors({
    origin: process.env.DASHBOARD_ORIGIN?.split(',') ?? true,
    credentials: true,
  });
  app.setGlobalPrefix('api', { exclude: ['health'] });

  if (process.env.NODE_ENV !== 'production') {
    const config = new DocumentBuilder()
      .setTitle('AI Towing Receptionist')
      .setDescription(
        'Answers missed towing calls, collects a structured lead, and notifies ' +
          'the towing company on WhatsApp. Every endpoint is scoped to the ' +
          'business in the access token.',
      )
      .setVersion('0.1.0')
      .addBearerAuth()
      .build();

    SwaggerModule.setup('api/docs', app, SwaggerModule.createDocument(app, config));
    logger.log('API documentation available at /api/docs');
  }

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port, '0.0.0.0');

  // WebSocket gateways attach to the running HTTP server, and only for the
  // selected pipeline — a gather-only deployment opens no socket.
  if (process.env.VOICE_PIPELINE === 'stream') {
    app.get(MediaStreamGateway).attach(app.getHttpServer());
  } else if (process.env.VOICE_PIPELINE === 'chatgpt') {
    app.get(RealtimeVoiceGateway).attach(app.getHttpServer());
  }
  logger.log(`Listening on port ${port}`);
}

void bootstrap();
