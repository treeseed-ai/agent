import { describe, expect, it } from 'vitest';
import { missingReviewResult, reviewToolOutcome } from '../../../src/provider/execution/activity/review-diagnostics.ts';

describe('review failure diagnostics', () => {
  it('preserves measured usage and stops automatic retries of a completed guest without a review', () => {
    const usage = { inputTokens: 123, outputTokens: 45, elapsedSeconds: 12 };
    const result = missingReviewResult(usage, [], { teardown: { verified: true } });
    expect(result).toMatchObject({ status: 'failed', code: 'workday_artifact_missing', retryable: false, usage: [usage] });
    expect(result.outputs?.teardown).toEqual({ verified: true });
  });
  it('reports the publication failure without leaking credentials or provider URLs', () => {
    const outcome = reviewToolOutcome('treeseed_publish_review', new Error('write failed: lease-private Bearer access-private https://private.example/?token=secret'), ['lease-private']);
    const result = missingReviewResult({}, [outcome], {});
    expect(result.summary).toContain('write failed');
    for (const secret of ['lease-private', 'access-private', 'private.example', 'token=secret']) expect(JSON.stringify(result)).not.toContain(secret);
  });
  it('bounds diagnostics and distinguishes a missing call from a failed call', () => {
    const success = reviewToolOutcome('treedx_read_files');
    expect(success).toEqual({ tool: 'treedx_read_files', status: 'completed' });
    const result = missingReviewResult({}, Array.from({ length: 100 }, () => success), {});
    expect(result.outputs?.toolOutcomes).toHaveLength(32);
    expect(result.summary).toContain('no authorized, verified artifact');
  });
});
