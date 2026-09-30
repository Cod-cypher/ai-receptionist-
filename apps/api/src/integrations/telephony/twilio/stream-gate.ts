/**
 * Who may open a media stream.
 *
 * The WebSocket a call's audio arrives on is reachable by anyone who can
 * reach the API, and its `start` message named the tenant and the call.
 * Registration is public and hands back a business id, so that id alone was
 * enough to open paid realtime sessions on the platform's key, to speak any
 * greeting, and, with a call id, to drive that call's tools.
 *
 * The voice webhook now signs the ids it puts in the TwiML; the gateway
 * checks the signature when the stream starts, and then that the call
 * exists, is in progress, and belongs to the Twilio call the stream says it
 * carries. What the receptionist says first, and the number it offers as the
 * callback number, come from the call record, not from the socket.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { CallSessionService } from '../../../call-session/call-session.service';

export interface StreamClaims {
  businessId: string;
  callId: string;
  /** Twilio's own id for the call, which the stream's `start` message repeats. */
  callSid: string;
}

/** What the `start` message carries, as far as it is trusted before checking. */
export interface StreamStart {
  businessId?: string;
  callId?: string;
  callSid?: string;
  token?: string;
}

/** A stream that may go on, with what the call record says about it. */
export interface AdmittedStream {
  businessId: string;
  callId: string;
  callerNumber: string;
  greeting: string | null;
}

export type StreamVerdict = { ok: true; call: AdmittedStream } | { ok: false; reason: string };

/**
 * Keyed from the access-token secret under its own prefix, so there is no
 * new setting to configure. A JWT's signing input is base64, so no token can
 * be a JWT and no JWT a token.
 */
export function signStream(secret: string, claims: StreamClaims): string {
  return createHmac('sha256', secret)
    .update(`twilio-stream:v1\n${JSON.stringify([claims.businessId, claims.callId, claims.callSid])}`)
    .digest('hex');
}

export function verifyStream(secret: string, claims: StreamClaims, token: string | undefined): boolean {
  if (!token) return false;
  const expected = Buffer.from(signStream(secret, claims), 'hex');
  const given = Buffer.from(token, 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

@Injectable()
export class StreamGate {
  private readonly logger = new Logger('StreamGate');
  private readonly secret: string;

  constructor(
    config: ConfigService,
    private readonly callSession: Pick<CallSessionService, 'findLiveCall'>,
  ) {
    this.secret = config.getOrThrow<string>('JWT_ACCESS_SECRET');
  }

  /** The token the voice webhook puts in the TwiML that opens the stream. */
  sign(claims: StreamClaims): string {
    return signStream(this.secret, claims);
  }

  /** Whether a stream that has just started may carry a call, and which. */
  async admit(start: StreamStart): Promise<StreamVerdict> {
    const { businessId, callId, callSid, token } = start;
    if (!businessId || !callId || !callSid) return { ok: false, reason: 'the stream named no business, call or call sid' };
    if (!verifyStream(this.secret, { businessId, callId, callSid }, token)) return { ok: false, reason: 'the stream token is missing or wrong' };

    let live: Awaited<ReturnType<CallSessionService['findLiveCall']>>;
    try {
      live = await this.callSession.findLiveCall(businessId, callId);
    } catch (error) {
      this.logger.warn(`Could not look up call ${callId}: ${error instanceof Error ? error.message : error}`);
      return { ok: false, reason: 'the call could not be looked up' };
    }
    if (!live) return { ok: false, reason: 'no such call is in progress' };
    if (live.providerCallSid !== callSid) return { ok: false, reason: 'the stream is not for this call' };

    return { ok: true, call: { businessId, callId, callerNumber: live.fromNumber, greeting: live.greeting } };
  }
}
