import { createParamDecorator, type ExecutionContext } from '@nestjs/common';

import type { AuthenticatedRequest } from '../guards/jwt-auth.guard';
import type { AccessTokenClaims } from '../../modules/auth/auth.service';

/** The verified token claims for this request. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AccessTokenClaims => {
    const request = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!request.user) {
      throw new Error(
        'CurrentUser used on a route without JwtAuthGuard. This is a wiring bug.',
      );
    }
    return request.user;
  },
);

/**
 * The tenant this request is scoped to, taken from the signed token.
 * Every repository call takes this; none derive scope from the request body.
 */
export const BusinessId = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string => {
    const request = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!request.user) {
      throw new Error(
        'BusinessId used on a route without JwtAuthGuard. This is a wiring bug.',
      );
    }
    return request.user.businessId;
  },
);
