import { describe, expect, it, vi } from 'vitest';
import { resolveHandlerContextPacks } from '../../src/agents/context/context-processor.ts';

function mockPack(id: string) {
	return {
		seedIds: [id],
		totalTokenEstimate: 10,
		includedNodeIds: [`node:${id}`],
		nodes: [],
		edges: [],
	};
}

describe('handler context processor', () => {
	it('collects context queries and resolves graph context packs', async () => {
		const buildContextPack = vi.fn(async (request) => mockPack(String(request.query)));
		const result = await resolveHandlerContextPacks({
			sdk: { buildContextPack },
			agent: {
				slug: 'researcher-agent',
				handler: 'research',
				enabled: true,
				systemPrompt: 'Research carefully.',
				persona: 'Researcher',
				cli: {},
				triggers: [],
				permissions: [],
				execution: {
					maxConcurrency: 1,
					timeoutSeconds: 900,
					cooldownSeconds: 0,
					leaseSeconds: 300,
					retryLimit: 0,
					branchPrefix: 'agent',
				},
				outputs: { messageTypes: [], modelMutations: [] },
				context: {
					queries: [{
						id: 'runtime',
						purpose: 'research',
						query: 'agent runtime',
						scope: '/knowledge',
					}],
				},
			},
		});

		expect(buildContextPack).toHaveBeenCalledWith(expect.objectContaining({
			query: 'agent runtime',
			stage: 'research',
			scopePaths: ['/knowledge'],
		}));
		expect(result.contextPacks.get('runtime')?.pack.includedNodeIds).toEqual(['node:agent runtime']);
		expect(result.contextPacks.byPurpose('research')).toHaveLength(1);
	});

	it('merges duplicate ids by source priority', async () => {
		const buildContextPack = vi.fn(async (request) => mockPack(String(request.query)));
		const result = await resolveHandlerContextPacks({
			sdk: { buildContextPack },
			defaultRoleContext: [{
				id: 'shared',
				purpose: 'research',
				query: 'default query',
			}],
			contentRecords: [{
				ref: 'knowledge/runtime',
				context: {
					queries: [{
						id: 'shared',
						purpose: 'research',
						query: 'content query',
					}],
				},
			}],
			taskPayload: {
				context: {
					queries: [{
						id: 'shared',
						purpose: 'review',
						query: 'task query',
					}],
				},
			},
		});

		expect(buildContextPack).toHaveBeenCalledTimes(1);
		expect(buildContextPack).toHaveBeenCalledWith(expect.objectContaining({
			query: 'task query',
			stage: 'review',
		}));
		expect(result.contextPacks.get('shared')?.source).toBe('task_payload');
	});

	it('skips invalid optional queries and propagates warnings', async () => {
		const result = await resolveHandlerContextPacks({
			sdk: { buildContextPack: vi.fn(async () => mockPack('unused')) },
			taskPayload: {
				context: {
					queries: [{
						id: 'bad',
						purpose: 'optimize',
						query: 'draft',
						depth: 9,
					}],
				},
			},
		});

		expect(result.contextPacks.all()).toEqual([]);
		expect(result.warnings.join('\n')).toContain('Skipped context query "bad"');
		expect(result.warnings.join('\n')).toContain('using "plan"');
	});

	it('throws when a required query is invalid', async () => {
		await expect(resolveHandlerContextPacks({
			sdk: { buildContextPack: vi.fn(async () => mockPack('unused')) },
			taskPayload: {
				context: {
					queries: [{
						id: 'required-bad',
						purpose: 'research',
						query: 'runtime',
						depth: 9,
						required: true,
					}],
				},
			},
		})).rejects.toThrow('Required context query "required-bad" failed validation');
	});

	it('skips optional queries when TreeDX context resolution fails', async () => {
		const result = await resolveHandlerContextPacks({
			sdk: { buildContextPack: vi.fn(async () => { throw new Error('Graph is not ready.'); }) },
			taskPayload: {
				context: {
					queries: [{
						id: 'optional-graph',
						purpose: 'plan',
						query: 'package planning',
					}],
				},
			},
		});

		expect(result.contextPacks.all()).toEqual([]);
		expect(result.warnings.join('\n')).toContain('Skipped context query "optional-graph" after TreeDX context resolution failed: Graph is not ready.');
	});

	it('throws when required TreeDX context resolution fails', async () => {
		await expect(resolveHandlerContextPacks({
			sdk: { buildContextPack: vi.fn(async () => { throw new Error('Graph is not ready.'); }) },
			taskPayload: {
				context: {
					queries: [{
						id: 'required-graph',
						purpose: 'plan',
						query: 'package planning',
						required: true,
					}],
				},
			},
		})).rejects.toThrow('Required context query "required-graph" failed during TreeDX context resolution: Graph is not ready.');
	});
});
