export function parseAgentReleaseVersion(tagName: string, packageVersion: string) {
	if (tagName !== packageVersion) {
		throw new Error(`Release tag "${tagName}" does not match @treeseed/agent version "${packageVersion}".`);
	}
	if (/^\d+\.\d+\.\d+$/u.test(tagName)) return { channel: 'stable' as const, distTag: 'latest' as const };
	if (/^\d+\.\d+\.\d+-rc\.\d+$/u.test(tagName)) return { channel: 'prerelease' as const, distTag: 'rc' as const };
	throw new Error(`Release tag "${tagName}" must be an exact stable or rc.N semantic version.`);
}
