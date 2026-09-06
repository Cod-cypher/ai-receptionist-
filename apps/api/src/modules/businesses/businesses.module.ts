import { Module } from '@nestjs/common';

import { BusinessConfigService } from './business-config.service';
import { BusinessesController } from './businesses.controller';
import { BusinessesService } from './businesses.service';

@Module({
  controllers: [BusinessesController],
  providers: [BusinessConfigService, BusinessesService],
  exports: [BusinessConfigService, BusinessesService],
})
export class BusinessesModule {}
