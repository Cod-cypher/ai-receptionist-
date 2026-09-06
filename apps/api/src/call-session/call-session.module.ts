import { Global, Module } from '@nestjs/common';

import { CallSessionService } from './call-session.service';
import { CallSessionStore } from './call-session.store';
import { BusinessesModule } from '../modules/businesses/businesses.module';
import { NotificationsModule } from '../modules/notifications/notifications.module';

@Global()
@Module({
  imports: [BusinessesModule, NotificationsModule],
  providers: [CallSessionService, CallSessionStore],
  exports: [CallSessionService, CallSessionStore],
})
export class CallSessionModule {}
