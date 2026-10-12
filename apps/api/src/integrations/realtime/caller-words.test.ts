import { describe, expect, it } from 'vitest';

import { classifyCallerWords, isBackchannel } from './caller-words';

describe('isBackchannel', () => {
  it('recognises words of acknowledgement, in any mix', () => {
    for (const said of ['Okay.', 'uh-huh', 'Yeah, okay.', 'Mm-hmm.', 'Right, got it.', 'yes', 'Sure!']) {
      expect(isBackchannel(said), said).toBe(true);
    }
  });

  it('treats anything with content as the caller taking the floor', () => {
    for (const said of ['Okay, but it is a Ford.', 'Hello?', 'Wait.', 'Yes, exit 12.', 'No.']) {
      expect(isBackchannel(said), said).toBe(false);
    }
  });
});

describe('classifyCallerWords', () => {
  it('knows the kinds the helpers recognise, and a plain question', () => {
    expect(classifyCallerWords('Okay.')).toBe('backchannel');
    expect(classifyCallerWords('Can you hear me?')).toBe('line_check');
    expect(classifyCallerWords('Hold on, let me find the exit.')).toBe('asking_for_time');
    expect(classifyCallerWords('What information have I already given you?')).toBe('question');
  });
});
