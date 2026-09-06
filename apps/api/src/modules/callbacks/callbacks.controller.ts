import { Body, Controller, Get, Param, Patch, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';

import { CallbacksService } from './callbacks.service';
import { BusinessId, CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import type { AccessTokenClaims } from '../auth/auth.service';

const ListQuerySchema = z.object({
  status: z.enum(['open', 'resolved']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
});

const StatusSchema = z.object({ status: z.enum(['open', 'resolved']) });

@ApiTags('callbacks')
@ApiBearerAuth()
@Controller('callbacks')
@UseGuards(JwtAuthGuard)
export class CallbacksController {
  constructor(private readonly callbacks: CallbacksService) {}

  @Get()
  @ApiOperation({ summary: 'List callback requests' })
  async list(@BusinessId() businessId: string, @Query() query: unknown) {
    return this.callbacks.list(businessId, ListQuerySchema.parse(query));
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get one callback request, including its transcript' })
  async findOne(@BusinessId() businessId: string, @Param('id') id: string) {
    return this.callbacks.findOne(businessId, z.string().uuid().parse(id));
  }

  @Patch(':id/status')
  @ApiOperation({ summary: 'Open or resolve a callback request' })
  async updateStatus(
    @BusinessId() businessId: string,
    @CurrentUser() user: AccessTokenClaims,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const { status } = StatusSchema.parse(body);
    return this.callbacks.updateStatus(
      businessId,
      user.sub,
      z.string().uuid().parse(id),
      status,
    );
  }
}
