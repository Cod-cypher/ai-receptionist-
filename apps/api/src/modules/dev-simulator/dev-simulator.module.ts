import { DynamicModule, Logger, Module } from '@nestjs/common';

import { DevSimulatorController } from './dev-simulator.controller';
import { DirectRequestGuard } from './direct-request.guard';
import { BusinessesModule } from '../businesses/businesses.module';
import { CallsModule } from '../calls/calls.module';

/**
 * Registered conditionally: the controller is unauthenticated, so in production
 * it must not exist at all rather than merely be guarded. The config schema
 * separately refuses to boot with ENABLE_DEV_SIMULATOR=true under
 * NODE_ENV=production, so two independent things have to go wrong to expose it.
 */
@Module({})
export class DevSimulatorModule {
  static forRoot(): DynamicModule {
    const enabled =
      process.env.ENABLE_DEV_SIMULATOR === 'true' &&
      process.env.NODE_ENV !== 'production';

    if (enabled) {
      new Logger('DevSimulator').warn(
        'Text simulator enabled at POST /dev/conversations. This endpoint is unauthenticated.',
      );
    }

    return {
      module: DevSimulatorModule,
      imports: enabled ? [BusinessesModule, CallsModule] : [],
      controllers: enabled ? [DevSimulatorController] : [],
      providers: enabled ? [DirectRequestGuard] : [],
    };
  }
}
