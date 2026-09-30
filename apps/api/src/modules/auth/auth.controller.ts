import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { isKnownTimeZone } from '@towai/shared';
import { z } from 'zod';

import { AuthService } from './auth.service';
import { Public } from '../../common/decorators/public.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';

const RegisterSchema = z.object({
  businessName: z.string().trim().min(2).max(120),
  email: z.string().trim().email().max(254),
  // Long rather than complex: length is what resists guessing.
  password: z.string().min(12).max(200),
  name: z.string().trim().min(1).max(120),
  timezone: z.string().trim().max(64).refine(isKnownTimeZone, 'not a time zone this system knows').optional(),
});

const LoginSchema = z.object({
  email: z.string().trim().email().max(254),
  password: z.string().min(1).max(200),
});

const RefreshSchema = z.object({ refreshToken: z.string().min(1) });

@ApiTags('auth')
@Controller('auth')
@UseGuards(JwtAuthGuard)
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  // Registration is expensive (argon2) and creates tenants; rate limit hard.
  @Throttle({ default: { limit: 5, ttl: 3_600_000 } })
  @Post('register')
  @ApiOperation({ summary: 'Create a towing company and its first owner account' })
  async register(@Body() body: unknown) {
    const input = RegisterSchema.parse(body);
    const { tokens, user } = await this.auth.register(input);
    return {
      ...tokens,
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
      businessId: user.businessId,
    };
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 900_000 } })
  @Post('login')
  @HttpCode(200)
  @ApiOperation({ summary: 'Exchange credentials for an access and refresh token' })
  async login(@Body() body: unknown) {
    const input = LoginSchema.parse(body);
    const { tokens, user } = await this.auth.login(input.email, input.password);
    return {
      ...tokens,
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
      businessId: user.businessId,
    };
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  @ApiOperation({ summary: 'Exchange a refresh token for a new pair' })
  async refresh(@Body() body: unknown) {
    const input = RefreshSchema.parse(body);
    return this.auth.refresh(input.refreshToken);
  }

  @Public()
  @Post('logout')
  @HttpCode(204)
  @ApiOperation({ summary: 'Revoke a refresh token' })
  async logout(@Body() body: unknown) {
    const input = RefreshSchema.parse(body);
    await this.auth.logout(input.refreshToken);
  }
}
