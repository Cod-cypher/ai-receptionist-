import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';

import {
  BusinessesService,
  UpdateBusinessSchema,
  UpdateSettingsSchema,
} from './businesses.service';
import { BusinessId, CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { Roles, RolesGuard } from '../../common/guards/roles.guard';
import type { AccessTokenClaims } from '../auth/auth.service';

const ServiceSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).nullable().optional(),
  sortOrder: z.number().int().min(0).max(999).optional(),
});

const ServiceUpdateSchema = ServiceSchema.partial().extend({
  isActive: z.boolean().optional(),
});

const PhoneNumberSchema = z.object({
  e164: z.string().trim().regex(/^\+[1-9]\d{7,14}$/),
  providerSid: z.string().trim().max(64).optional(),
});

const Uuid = z.string().uuid();

@ApiTags('business')
@ApiBearerAuth()
@Controller('business')
@UseGuards(JwtAuthGuard, RolesGuard)
export class BusinessesController {
  constructor(private readonly businesses: BusinessesService) {}

  @Get()
  @ApiOperation({ summary: 'The authenticated business, its settings, services and numbers' })
  async profile(@BusinessId() businessId: string) {
    return this.businesses.getProfile(businessId);
  }

  @Put()
  @Roles('owner', 'manager')
  @ApiOperation({ summary: 'Update business details' })
  async update(
    @BusinessId() businessId: string,
    @CurrentUser() user: AccessTokenClaims,
    @Body() body: unknown,
  ) {
    return this.businesses.updateBusiness(
      businessId,
      user.sub,
      UpdateBusinessSchema.parse(body),
    );
  }

  @Put('settings')
  @Roles('owner', 'manager')
  @ApiOperation({ summary: 'Update receptionist settings: greeting, tone, FAQ, fallback' })
  async updateSettings(
    @BusinessId() businessId: string,
    @CurrentUser() user: AccessTokenClaims,
    @Body() body: unknown,
  ) {
    return this.businesses.updateSettings(
      businessId,
      user.sub,
      UpdateSettingsSchema.parse(body),
    );
  }

  @Get('services')
  @ApiOperation({ summary: 'List the services this company offers' })
  async listServices(@BusinessId() businessId: string) {
    return this.businesses.listServices(businessId);
  }

  @Post('services')
  @Roles('owner', 'manager')
  @ApiOperation({ summary: 'Add a service' })
  async createService(@BusinessId() businessId: string, @Body() body: unknown) {
    return this.businesses.createService(businessId, ServiceSchema.parse(body));
  }

  @Patch('services/:id')
  @Roles('owner', 'manager')
  @ApiOperation({ summary: 'Update a service' })
  async updateService(
    @BusinessId() businessId: string,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.businesses.updateService(
      businessId,
      Uuid.parse(id),
      ServiceUpdateSchema.parse(body),
    );
  }

  @Delete('services/:id')
  @Roles('owner', 'manager')
  @HttpCode(204)
  @ApiOperation({ summary: 'Remove a service' })
  async deleteService(@BusinessId() businessId: string, @Param('id') id: string) {
    await this.businesses.deleteService(businessId, Uuid.parse(id));
  }

  @Post('phone-numbers')
  @Roles('owner')
  @ApiOperation({
    summary: 'Attach a telephony number so inbound calls route to this business',
  })
  async addPhoneNumber(@BusinessId() businessId: string, @Body() body: unknown) {
    const input = PhoneNumberSchema.parse(body);
    return this.businesses.addPhoneNumber(businessId, input.e164, input.providerSid);
  }
}
