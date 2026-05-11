#!/usr/bin/env node

import { fileURLToPath } from 'node:url';
import { AgentKernel } from '../agents/kernel/agent-kernel.ts';
import { createServiceSdk, resolveServiceRepoRoot } from './common.ts';

function integerFromEnv(name: string, fallback: number) {
	const value = process.env[name];
	if (!value) return fallback;
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) ? parsed : fallback;
}

export function resolveAgentsServiceConfig() {
	return {
		serviceName: process.env.TREESEED_AGENTS_SERVICE_NAME?.trim() || 'agents',
		pollIntervalMs: integerFromEnv('TREESEED_AGENTS_POLL_INTERVAL_MS', 30000),
	};
}

export async function runAgentsCycle() {
	const sdk = createServiceSdk();
	const kernel = new AgentKernel(sdk, resolveServiceRepoRoot());
	const results = await kernel.runCycle();
	return {
		ok: true,
		processed: results.length,
		results,
	};
}

export async function startAgentsLoop() {
	const config = resolveAgentsServiceConfig();
	for (;;) {
		try {
			await runAgentsCycle();
		} catch (error) {
			process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		}
		await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs));
	}
}

const currentFile = fileURLToPath(import.meta.url);
const entryFile = process.argv[1] ?? '';
if (entryFile === currentFile) {
	await startAgentsLoop();
}
