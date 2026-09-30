/**
 * Only requests made straight to this machine.
 *
 * The simulator is unauthenticated: it starts calls, creates leads and reads
 * transcripts for any tenant. It is meant for a terminal on the developer's
 * own machine, but development runs behind a public tunnel so that Twilio
 * can reach the API, and the tunnel would carry anyone to it. A request that
 * came through a tunnel or a proxy carries forwarding headers; one made
 * directly does not.
 */

import { CanActivate, ExecutionContext, Injectable, NotFoundException } from '@nestjs/common';
import type { Request } from 'express';

const FORWARDING_HEADERS = ['x-forwarded-for', 'x-forwarded-host', 'x-real-ip', 'forwarded', 'cf-connecting-ip', 'cdn-loop', 'via'];

@Injectable()
export class DirectRequestGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const forwarded = FORWARDING_HEADERS.some((name) => request.headers[name] !== undefined);
    // A 404, as if the route did not exist: it does not, for anyone out there.
    if (forwarded) throw new NotFoundException();
    return true;
  }
}
