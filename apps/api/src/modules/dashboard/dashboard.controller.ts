import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';

import { DashboardService } from './dashboard.service';
import { BusinessId } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';

const QuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(365).default(30),
});

@ApiTags('dashboard')
@ApiBearerAuth()
@Controller('dashboard')
@UseGuards(JwtAuthGuard)
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get('overview')
  @ApiOperation({ summary: 'Headline counters and recent activity' })
  async overview(@BusinessId() businessId: string, @Query() query: unknown) {
    const { days } = QuerySchema.parse(query);
    const since = new Date(Date.now() - days * 86_400_000);
    return this.dashboard.overview(businessId, since);
  }
}
