import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';

import { CallsService } from './calls.service';
import { BusinessId } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';

const ListQuerySchema = z.object({
  outcome: z
    .enum(['lead_created', 'callback_created', 'faq_answered', 'abandoned', 'error'])
    .optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
});

@ApiTags('calls')
@ApiBearerAuth()
@Controller('calls')
@UseGuards(JwtAuthGuard)
export class CallsController {
  constructor(private readonly calls: CallsService) {}

  @Get()
  @ApiOperation({ summary: 'List calls for the authenticated business' })
  async list(@BusinessId() businessId: string, @Query() query: unknown) {
    return this.calls.list(businessId, ListQuerySchema.parse(query));
  }

  @Get(':id')
  @ApiOperation({ summary: 'Call detail: transcript, event trail, extracted fields and outcome' })
  async findOne(@BusinessId() businessId: string, @Param('id') id: string) {
    return this.calls.findOneDetailed(businessId, z.string().uuid().parse(id));
  }
}
