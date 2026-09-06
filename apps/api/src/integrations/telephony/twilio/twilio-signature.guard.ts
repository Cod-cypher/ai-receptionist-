/**
 * Verifies Twilio's request signature.
 *
 * Without this, the voice webhook is an open endpoint that will start a call,
 * run the conversation engine, create leads, and send WhatsApp messages for
 * anyone who POSTs to it. The signature covers the full URL and the form body,
 * so it has to be computed against the externally visible URL rather than
 * whatever the proxy rewrote it to.
 *
 * Disabling it is possible for local testing without a tunnel, and the config
 * schema refuses to boot with it disabled in production.
 */

import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { validateRequest } from 'twilio';

@Injectable()
export class TwilioSignatureGuard implements CanActivate {
  private readonly logger = new Logger('TwilioSignature');
  private readonly enabled: boolean;
  private readonly authToken: string | undefined;
  private readonly baseUrl: string;

  constructor(private readonly config: ConfigService) {
    this.enabled = this.config.get<boolean>('TWILIO_VALIDATE_SIGNATURE', true);
    this.authToken = this.config.get<string>('TWILIO_AUTH_TOKEN');
    this.baseUrl = this.config.get<string>('PUBLIC_BASE_URL', 'http://localhost:3000');

    if (!this.enabled) {
      this.logger.warn(
        'Twilio signature validation is DISABLED. Anyone who can reach this ' +
          'server can forge calls. Never run this way in production.',
      );
    }
  }

  canActivate(context: ExecutionContext): boolean {
    if (!this.enabled) return true;

    if (!this.authToken) {
      throw new ForbiddenException(
        'TWILIO_AUTH_TOKEN is not configured; cannot verify webhook signatures',
      );
    }

    const request = context.switchToHttp().getRequest<Request>();
    const signature = request.header('X-Twilio-Signature');

    if (!signature) throw new ForbiddenException('Missing Twilio signature');

    // Rebuild the URL Twilio signed: the public one, including the query
    // string, not the internal path a proxy may have rewritten.
    const url = new URL(request.originalUrl, this.baseUrl).toString();

    const valid = validateRequest(
      this.authToken,
      signature,
      url,
      (request.body ?? {}) as Record<string, unknown>,
    );

    if (!valid) {
      this.logger.warn(`Rejected a request to ${url} with an invalid Twilio signature`);
      throw new ForbiddenException('Invalid Twilio signature');
    }

    return true;
  }
}
