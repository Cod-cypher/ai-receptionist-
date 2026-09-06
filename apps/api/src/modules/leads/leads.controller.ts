import { Body, Controller, Get, Param, Patch, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { LEAD_STATUSES } from '@towai/shared';

import { LeadsService } from './leads.service';
import { BusinessId, CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import type { AccessTokenClaims } from '../auth/auth.service';

const ListQuerySchema = z.object({
  status: z.enum(LEAD_STATUSES as unknown as [string, ...string[]]).optional(),
  search: z.string().trim().max(120).optional(),
  since: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
});

const StatusSchema = z.object({
  status: z.enum(LEAD_STATUSES as unknown as [string, ...string[]]),
});

const UuidSchema = z.string().uuid();

@ApiTags('leads')
@ApiBearerAuth()
@Controller('leads')
@UseGuards(JwtAuthGuard)
export class LeadsController {
  constructor(private readonly leads: LeadsService) {}

  @Get()
  @ApiOperation({ summary: 'List leads for the authenticated business' })
  async list(@BusinessId() businessId: string, @Query() query: unknown) {
    const parsed = ListQuerySchema.parse(query);
    return this.leads.list(businessId, parsed as never);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get one lead' })
  async findOne(@BusinessId() businessId: string, @Param('id') id: string) {
    return this.leads.findOne(businessId, UuidSchema.parse(id));
  }

  @Patch(':id/status')
  @ApiOperation({ summary: 'Move a lead through new / contacted / completed / cancelled' })
  async updateStatus(
    @BusinessId() businessId: string,
    @CurrentUser() user: AccessTokenClaims,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const { status } = StatusSchema.parse(body);
    return this.leads.updateStatus(businessId, user.sub, UuidSchema.parse(id), status as never);
  }
}
