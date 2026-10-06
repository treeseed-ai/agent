import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { parse, stringify } from 'yaml';
import { expect, it } from 'vitest';
import { assignmentAttemptSchema } from '@treeseed/sdk/agent-capacity';
import { request } from '../kernel/provider-kernel-fixture.ts';

type Observed = { result?: { summary: string; references: Array<{ path: string; commit: string }> }; error?: string;
	publications: number; modelCalls: number; suppliedPredecessors: number; base: string; head: string; exists: boolean; inputUnchanged: boolean;
	expectedSummary: string; published: string | null; status: string };
function native(mode: string, agentClass = 'configured-planner'): Observed {
	const root = mkdtempSync(resolve(tmpdir(), 'agent-planning-publication-'));
	try {
		const assignment = assignmentAttemptSchema.parse(request().assignment.assignmentAttempt);
		assignment.agentClass = agentClass;
		Object.assign(assignment.effectiveProfile, parse(`activity: planning\nhandler: writer\nhandlerOrigin: agent-package\nprompt:\n  system: Incorporate all eight exact predecessor contributions and preserve their material evidence.\n`));
		assignment.effectiveProfile.permissionCeiling = { content: { read: ['note'], write: ['note'] }, tools: [] };
		const input = resolve(root, 'assignment.yaml'); writeFileSync(input, stringify(assignment));
		const child = spawnSync(process.execPath, ['--import', 'tsx', resolve(import.meta.dirname, 'planning-native.ts'), input, mode],
			{ cwd: resolve(import.meta.dirname, '../../..'), encoding: 'utf8', timeout: 10_000 });
		expect(child.error).toBeUndefined(); expect(child.status, child.stderr).toBe(0);
		return JSON.parse(child.stdout) as Observed;
	} finally { rmSync(root, { recursive: true, force: true }); }
}

it('publishes all eight material contributions through the configured Writer and native exact commit readback', () => {
	for (const identity of ['configured-planner', 'renamed-planner']) {
		const observed = native('valid', identity);
		expect(observed.error).toBeUndefined(); expect(observed.publications).toBe(1); expect(observed.modelCalls).toBe(1);
		expect(observed.suppliedPredecessors).toBe(8);
		expect(observed.result?.summary).toBe(observed.expectedSummary);
		expect(observed.result?.references).toMatchObject([{ path: 'notes/synthesis.mdx', commit: observed.head }]);
		expect(observed.head).not.toBe(observed.base); expect(observed.published).toContain(observed.expectedSummary);
		expect(observed.status).toBe(''); expect(observed.inputUnchanged).toBe(true);
	}
});
it('denies an omitted predecessor before the owning Writer can publish a real native commit', () => {
	const observed = native('omitted');
	expect(observed, JSON.stringify(observed)).toMatchObject({ error: expect.stringMatching(/predecessor|planning/iu) });
	expect(observed.publications).toBe(0); expect(observed.exists).toBe(false); expect(observed.head).toBe(observed.base);
	expect(observed.inputUnchanged).toBe(true); expect(observed.status).toBe('');
});
it('denies identifier-only and foreign-result synthesis before native content publication', () => {
	const observations = ['empty-material', 'foreign'].map(mode => native(mode));
	for (const observed of observations) {
		expect(observed, JSON.stringify(observations)).toMatchObject({ error: expect.stringMatching(/predecessor|planning/iu) });
		expect(observed.publications).toBe(0); expect(observed.exists).toBe(false); expect(observed.head).toBe(observed.base);
		expect(observed.inputUnchanged).toBe(true); expect(observed.status).toBe('');
	}
});
it('retains exact native predecessors and no output residue after provider failure or denied write authority', () => {
	for (const mode of ['provider-error', 'denied']) {
		const observed = native(mode);
		expect(observed.error).toMatch(/controlled_model_failure|writer_content_commit_grant_required/u);
		expect(observed.publications).toBe(0); expect(observed.exists).toBe(false); expect(observed.head).toBe(observed.base);
		expect(observed.inputUnchanged).toBe(true); expect(observed.status).toBe('');
	}
});
