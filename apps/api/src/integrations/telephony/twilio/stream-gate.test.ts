import { describe, expect, it, vi } from 'vitest';

import { StreamGate, signStream, verifyStream } from './stream-gate';

const SECRET = 'an-access-token-secret-of-at-least-32-characters';
const CLAIMS = { businessId: 'biz-1', callId: 'call-1', callSid: 'CA1' };

type LiveCall = { providerCallSid: string | null; fromNumber: string; greeting: string | null };

/** A gate over a call session that knows one call, or none, or cannot answer. */
function gate(live: LiveCall | null | Error) {
  const config = { getOrThrow: () => SECRET };
  const callSession = {
    findLiveCall: vi.fn(async () => {
      if (live instanceof Error) throw live;
      return live;
    }),
  };
  return { gate: new StreamGate(config as never, callSession), callSession };
}

const LIVE = { providerCallSid: 'CA1', fromNumber: '+18174098408', greeting: 'Thanks for calling Liberty Towing. How can I help?' };

describe('the stream token', () => {
  it('is the same for the same call, and different for any other', () => {
    const token = signStream(SECRET, CLAIMS);
    expect(verifyStream(SECRET, CLAIMS, token)).toBe(true);
    expect(verifyStream(SECRET, { ...CLAIMS, callId: 'call-2' }, token)).toBe(false);
    expect(verifyStream(SECRET, { ...CLAIMS, callSid: 'CA2' }, token)).toBe(false);
    expect(verifyStream('another-secret-of-at-least-32-characters-x', CLAIMS, token)).toBe(false);
    expect(verifyStream(SECRET, CLAIMS, undefined)).toBe(false);
    expect(verifyStream(SECRET, CLAIMS, 'not-hex')).toBe(false);
  });
});

describe('the stream gate', () => {
  it('admits the stream the voice webhook set up, with the greeting and number from the call record', async () => {
    const { gate: g, callSession } = gate(LIVE);
    const verdict = await g.admit({ ...CLAIMS, token: g.sign(CLAIMS) });

    expect(verdict).toEqual({
      ok: true,
      call: { businessId: 'biz-1', callId: 'call-1', callerNumber: '+18174098408', greeting: LIVE.greeting },
    });
    expect(callSession.findLiveCall).toHaveBeenCalledWith('biz-1', 'call-1');
  });

  it('refuses a stream with no token, or a token made for another call, before touching the database', async () => {
    const { gate: g, callSession } = gate(LIVE);
    expect((await g.admit({ ...CLAIMS })).ok).toBe(false);
    expect((await g.admit({ ...CLAIMS, token: g.sign({ ...CLAIMS, callId: 'call-2' }) })).ok).toBe(false);
    expect((await g.admit({ businessId: 'biz-1', token: g.sign(CLAIMS) })).ok).toBe(false);
    expect(callSession.findLiveCall).not.toHaveBeenCalled();
  });

  it('refuses a call that has ended, one that is not this Twilio call, and one it cannot look up', async () => {
    expect(await gate(null).gate.admit({ ...CLAIMS, token: signStream(SECRET, CLAIMS) })).toEqual({ ok: false, reason: 'no such call is in progress' });
    expect(await gate({ ...LIVE, providerCallSid: 'CA9' }).gate.admit({ ...CLAIMS, token: signStream(SECRET, CLAIMS) })).toEqual({
      ok: false,
      reason: 'the stream is not for this call',
    });
    expect((await gate(new Error('invalid input syntax for type uuid')).gate.admit({ ...CLAIMS, token: signStream(SECRET, CLAIMS) })).ok).toBe(false);
  });
});
