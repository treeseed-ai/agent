import { describe, expect, it } from 'vitest';
import { activeSandboxAttempt } from '../../../src/provider/execution/source-workspace.ts';

describe('source attempt lifecycle mapping', () => {
  it.each([0, 1, 2, 100])('keeps lifecycle counter %i distinct', counter => {
    expect(activeSandboxAttempt(counter)).toBe(counter + 1);
  });
  it.each([undefined, null, '0', -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER])('rejects malformed counters without defaulting', counter => {
    expect(() => activeSandboxAttempt(counter)).toThrow('invalid lifecycle');
  });
});
