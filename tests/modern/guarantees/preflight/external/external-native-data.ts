import { developmentRuntimeSchema, developmentSessionSchema } from '@treeseed/sdk/development';
import { hostConfigurationSchema } from '@treeseed/sdk/deployment';

/** Controlled owning configuration, never actual campaign authority. */
export function nativeDevelopmentData(commit: string) {
	const host = hostConfigurationSchema.parse({ schemaVersion: 'treeseed.host/v1', configurationId: 'external-native-host', generation: 1,
		host: { id: 'external-native-host', role: 'integrated', architecture: 'amd64' }, runtime: { management: 'managed', environment: 'production' },
		updates: { defaultTrack: 'stable', stable: { metadataPollSeconds: 86400, maintenanceWindow: { weekday: 'sunday', localTime: '03:00', jitterMinutes: 30 } }, development: { pollSeconds: 60 } },
		components: {}, network: { manager: { binding: '127.0.0.1:4790', aliases: ['manager.treeseed.localhost'], sans: ['manager.treeseed.localhost'], trustedLanCidrs: [] } },
		fleet: { rolloutGroup: 'development-native-fixture', receiptReporting: { enabled: false, intervalSeconds: 300 } }, secrets: {} });
	const runtime = developmentRuntimeSchema.parse({ schemaVersion: 'treeseed.development-runtime/v2', project: { id: 'native-project', repository: 'treeseed-ai/sdk' }, defaults: { restoreOnFailure: true },
		targets: [{ id: 'source', kind: 'source-check', platforms: ['linux-amd64'], sourceRoots: ['src'], operations: { verify: { command: process.execPath, args: ['--version'], environment: {}, timeoutSeconds: 5 } },
			ready: { kind: 'process' }, statePolicy: 'stateless', migrationPolicy: 'none', shutdown: { graceSeconds: 5, activeWorkPolicy: 'block' }, promotion: { liveAdmissible: false, candidateRequiresVerification: true } }] });
	const session = developmentSessionSchema.parse({ schemaVersion: 'treeseed.development-session/v2', sessionId: 'external-native-session', actor: 'native-owner', hostId: 'external-native-host', createdAt: '2026-10-14T00:00:00.000Z', status: 'planning',
		repositories: [{ projectId: 'native-project', repository: 'treeseed-ai/sdk', worktree: '/controlled/source', commit, branch: 'staging', dirty: false, dirtyDigest: null, recipeDigest: 'sha256:' + 'a'.repeat(64) }],
		targets: [{ projectId: 'native-project', targetId: 'source', mode: 'live', generation: 1, health: 'ready' }], leases: [], restoredReceiptId: null, blockers: [] });
	return { host, runtime, session };
}
