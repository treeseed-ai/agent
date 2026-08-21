import { describe, expect, it } from 'vitest';
import { parseAgentReleaseVersion } from '../../../scripts/packages/release-version.ts';

describe('Agent release version policy', () => {
	it('routes exact stable and RC versions to isolated npm dist-tags', () => {
		expect(parseAgentReleaseVersion('0.13.0', '0.13.0')).toEqual({ channel: 'stable', distTag: 'latest' });
		expect(parseAgentReleaseVersion('0.13.0-rc.1', '0.13.0-rc.1')).toEqual({ channel: 'prerelease', distTag: 'rc' });
	});

	it('rejects mismatches and unsupported prerelease channels', () => {
		expect(() => parseAgentReleaseVersion('0.13.0-rc.1', '0.13.0-rc.2')).toThrow(/does not match/u);
		expect(() => parseAgentReleaseVersion('0.13.0-beta.1', '0.13.0-beta.1')).toThrow(/stable or rc\.N/u);
		expect(() => parseAgentReleaseVersion('v0.13.0', 'v0.13.0')).toThrow(/stable or rc\.N/u);
	});
});
