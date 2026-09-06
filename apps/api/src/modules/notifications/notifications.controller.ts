import { Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { and, count, desc, eq, type SQL } from 'drizzle-orm';
import { z } from 'zod';

import { NotificationsService } from './notifications.service';
import { BusinessId } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { DatabaseService } from '../../database/database.module';
import { notifications } from '../../database/schema';

const ListQuerySchema = z.object({
  status: z.enum(['pending', 'sent', 'failed', 'dead']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
});

@ApiTags('notifications')
@ApiBearerAuth()
@Controller('notifications')
@UseGuards(JwtAuthGuard)
export class NotificationsController {
  constructor(
    private readonly notifications: NotificationsService,
    private readonly database: DatabaseService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Delivery status of lead and callback notifications' })
  async list(@BusinessId() businessId: string, @Query() query: unknown) {
    const parsed = ListQuerySchema.parse(query);

    return this.database.withTenant(businessId, async (tx) => {
      const filters: SQL[] = [eq(notifications.businessId, businessId)];
      if (parsed.status) filters.push(eq(notifications.status, parsed.status));
      const where = and(...filters);

      const [items, totals] = await Promise.all([
        tx
          .select()
          .from(notifications)
          .where(where)
          .orderBy(desc(notifications.createdAt))
          .limit(parsed.limit)
          .offset(parsed.offset),
        tx.select({ value: count() }).from(notifications).where(where),
      ]);

      return { items, total: totals[0]?.value ?? 0, limit: parsed.limit, offset: parsed.offset };
    });
  }

  @Post(':id/retry')
  @ApiOperation({
    summary: 'Re-queue a notification whose delivery attempts were exhausted',
  })
  async retry(@BusinessId() businessId: string, @Param('id') id: string) {
    const notificationId = z.string().uuid().parse(id);
    await this.notifications.retryManually(businessId, notificationId);
    const status = await this.notifications.deliver(businessId, notificationId);
    return { status };
  }
}
