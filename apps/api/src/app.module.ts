import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';

import { validateEnv } from './config/configuration';
import { DatabaseModule } from './database/database.module';
import { AiModule } from './integrations/ai/ai.module';
import { WhatsAppModule } from './integrations/whatsapp/whatsapp.module';
import { ConversationModule } from './conversation/conversation.module';
import { CallSessionModule } from './call-session/call-session.module';
import { AuthModule } from './modules/auth/auth.module';
import { BusinessesModule } from './modules/businesses/businesses.module';
import { CallsModule } from './modules/calls/calls.module';
import { LeadsModule } from './modules/leads/leads.module';
import { CallbacksModule } from './modules/callbacks/callbacks.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';
import { TelephonyModule } from './integrations/telephony/telephony.module';
import { SttModule } from './integrations/stt/stt.module';
import { TtsModule } from './integrations/tts/tts.module';
import { DevSimulatorModule } from './modules/dev-simulator/dev-simulator.module';
import { HealthController } from './health.controller';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      // The repo-root .env serves the whole monorepo; the first path that
      // exists wins, so a per-app override is still possible.
      envFilePath: ['.env', '../../.env'],
      // Boot fails on invalid configuration rather than discovering it mid-call.
      validate: validateEnv,
    }),
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 120 }]),
    DatabaseModule,
    AiModule,
    WhatsAppModule,
    SttModule,
    TtsModule,
    ConversationModule,
    CallSessionModule,
    AuthModule,
    BusinessesModule,
    CallsModule,
    LeadsModule,
    CallbacksModule,
    NotificationsModule,
    DashboardModule,
    TelephonyModule,
    DevSimulatorModule.forRoot(),
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}
