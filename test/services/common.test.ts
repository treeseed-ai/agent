import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveWorkerConfig } from '../../src/services/common.ts';

describe('worker service config', () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it('uses Railway volume mount path as the runner repository root', () => {
		vi.stubEnv('RAILWAY_VOLUME_MOUNT_PATH', '/data');

		expect(resolveWorkerConfig()).toMatchObject({
			volumeRoot: '/data',
		});
	});

	it('lets Treeseed runner volume root override Railway-provided volume paths', () => {
		vi.stubEnv('TREESEED_RUNNER_VOLUME_ROOT', '/data');
		vi.stubEnv('RAILWAY_VOLUME_MOUNT_PATH', '/ignored');

		expect(resolveWorkerConfig()).toMatchObject({
			volumeRoot: '/data',
		});
	});

	it('keeps a local fallback when no deployed volume is present', () => {
		expect(resolveWorkerConfig()).toMatchObject({
			volumeRoot: '.treeseed-runner',
		});
	});
});
