import { access, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { describe, expect, it } from 'vitest';
import { materializeSandboxInputs } from '../../../../src/provider/execution/sandbox-input-materializer.ts';
import { parseWorkload } from '../../../../src/sandbox/workload.ts';
import { promptFromContext } from '../../../../src/kernel/handlers/model-workload-contract.ts';
import { request } from '../../kernel/provider-kernel-fixture.ts';
import { parse } from 'yaml';

describe('configured handler to opaque workload handoff', () => {
	it('binds the exact prepared request and executable as signed read-only inputs and cleans its real files', async () => {
		const input = request();
		input.modelInvocation = { prompt: 'Only these configured instructions.', context: [{ exact: 'authorized context' }], parameters: { temperature: 0.25 } };
		const before = structuredClone(input.modelInvocation), result = await materializeSandboxInputs(input);
		const model = result.inputs.find(item => item.id === 'model-request'), workload = result.inputs.find(item => item.id === 'workload');
		if (!model || !workload) throw new Error('Prepared workload inputs missing');
		const root = dirname(model.sourcePath);
		try {
			expect(JSON.parse(await readFile(model.sourcePath, 'utf8'))).toEqual(before);
			expect(parseWorkload(JSON.parse(await readFile(workload.sourcePath, 'utf8')))).toEqual({ executable: '/usr/local/bin/node',
				arguments: ['/app/dist/kernel/handlers/model-workload.js'], workingDirectory: '/workspace' });
			expect([model.disposition, workload.disposition]).toEqual(['read-only', 'read-only']);
			expect([model.digest, workload.digest]).toEqual([expect.stringMatching(/^sha256:[a-f0-9]{64}$/u), expect.stringMatching(/^sha256:[a-f0-9]{64}$/u)]);
			expect(input.modelInvocation).toEqual(before);
		} finally { await result.cleanup(); }
		await expect(access(root)).rejects.toMatchObject({ code: 'ENOENT' });
	});
	it('refuses to reconstruct a missing handler request from agent or assignment metadata', async () => {
		await expect(materializeSandboxInputs(request())).rejects.toThrow('prepared_model_request_required');
	});
	it('renders configured instructions and exact data without adding role or release policy', () => {
		const assignment = { authorityRefs: [{ model: 'decision' }], effectiveProfile: { activity: 'reviewing', handler: 'releaser',
			prompt: { system: 'Review only the accepted interface repair.', instructions: ['Preserve exact candidate references.'] } },
			requiredCapabilities: ['treeseed.engineering.release'], acceptanceCriteria: ['Later checks are coordinator release gates.'] };
		const rendered = promptFromContext({ canonicalAssignmentContext: { assignment, context: [], predecessorResults: [] } });
		expect(rendered).toContain(assignment.effectiveProfile.prompt.system);
		expect(rendered).toContain(assignment.effectiveProfile.prompt.instructions[0]);
		expect(rendered).not.toContain('standalone command npm pack');
		expect(rendered).not.toContain('tarball packed in this workspace');
		expect(rendered).not.toContain('CURRENT-ATTEMPT INDEPENDENT RELEASE VERIFICATION');
	});
	it('takes all task instructions from governed YAML across arbitrary identities handlers and activities', () => {
		const prompt = parse('system: Follow the accepted source repair.\ninstructions:\n  - Preserve the original deadline.\n  - Report only observed results.\n');
		for (const agentClass of ['architect', 'technical-writer', 'tester', 'engineer', 'reviewer', 'releaser', 'arbitrary-renamed-agent']) {
			for (const activity of ['planning', 'estimating', 'acting', 'reviewing', 'reporting', 'chat']) {
				for (const handler of ['writer', 'estimate', 'actor', 'reviewer', 'releaser']) {
					const context = { assignment: { agentClass, authorityRefs: [{ model: 'decision' }],
						effectiveProfile: { activity, handler, prompt } },
						context: [{ ref: { commit: 'a'.repeat(40) }, value: { body: 'Original exact source context.' } }],
						predecessorResults: [{ id: 'original-result', summary: 'Original contribution.', usage: { provenance: 'unavailable' } }] };
					const before = structuredClone(context), rendered = promptFromContext({ canonicalAssignmentContext: context });
					const sections = rendered.split('\n\n');
					expect(sections.slice(0, -1)).toEqual([prompt.system, ...prompt.instructions]);
					const expected = structuredClone(context);
					Reflect.deleteProperty(expected.assignment.effectiveProfile, 'prompt');
					expect(JSON.parse(sections.at(-1)!)).toEqual({ canonicalAssignmentContext: expected });
					expect(context).toEqual(before);
				}
			}
		}
	});
	it('rejects a missing configured system prompt instead of substituting role defaults', () => {
		for (const prompt of [undefined, {}, { system: '' }, { system: ' ' }]) {
			expect(() => promptFromContext({ canonicalAssignmentContext: { assignment: { effectiveProfile: { activity: 'chat', handler: 'writer', prompt } } } }))
				.toThrow('configured_model_prompt_required');
		}
	});
});
