import { describe, expect, it } from 'vitest';
import { prepareLaunchIntentWithCredentialSessions } from '../../src/services/remote-runner.ts';

describe('remote runner launch credential preparation', () => {
	it('projects repository, web, and email host sessions into the launch intent and environment', async () => {
		const consumed: string[] = [];
		const runner = {
			async consumeCredentialSession(_jobId: string, sessionId: string) {
				consumed.push(sessionId);
				const payloads: Record<string, unknown> = {
					repo: {
						config: {
							GH_TOKEN: 'repo-token',
							organizationOrOwner: 'team-github',
						},
					},
					web: {
						config: {
							CLOUDFLARE_API_TOKEN: 'cf-token',
							CLOUDFLARE_ACCOUNT_ID: 'cf-account',
						},
					},
					email: {
						config: {
							TREESEED_SMTP_HOST: 'smtp.example.test',
							TREESEED_SMTP_PORT: '587',
							TREESEED_SMTP_PASSWORD: 'smtp-secret',
						},
					},
				};
				return { payload: payloads[sessionId] };
			},
		};

		const prepared = await prepareLaunchIntentWithCredentialSessions(
			runner as never,
			'job-1',
			{
				credentialSessions: {
					repositoryHost: 'repo',
					webHost: 'web',
					emailHost: 'email',
				},
			},
			{
				repository: { owner: 'old-owner' },
				execution: {
					providerLaunchInput: {
						repoOwner: 'old-owner',
						cloudflareHost: { mode: 'team_owned' },
						emailHost: { mode: 'team_owned' },
					},
				},
			},
		);

		expect(consumed).toEqual(['repo', 'web', 'email']);
		expect(prepared.envOverlay).toMatchObject({
			GH_TOKEN: 'repo-token',
			GITHUB_TOKEN: 'repo-token',
			CLOUDFLARE_API_TOKEN: 'cf-token',
			CLOUDFLARE_ACCOUNT_ID: 'cf-account',
			TREESEED_SMTP_HOST: 'smtp.example.test',
			TREESEED_SMTP_PORT: '587',
			TREESEED_SMTP_PASSWORD: 'smtp-secret',
		});
		expect(prepared.intent.repository).toMatchObject({ owner: 'team-github' });
		expect(prepared.intent.execution).toMatchObject({
			providerLaunchInput: {
				repoOwner: 'team-github',
				cloudflareHost: {
					mode: 'team_owned',
					config: {
						CLOUDFLARE_API_TOKEN: 'cf-token',
						CLOUDFLARE_ACCOUNT_ID: 'cf-account',
					},
				},
				emailHost: {
					mode: 'team_owned',
					config: {
						TREESEED_SMTP_HOST: 'smtp.example.test',
						TREESEED_SMTP_PORT: '587',
						TREESEED_SMTP_PASSWORD: 'smtp-secret',
					},
				},
			},
		});
	});
});
