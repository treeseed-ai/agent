import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../../../../src/sandbox/process-runner.ts';
import { verifyReportedActivityCommands } from '../../../../src/sandbox/guest.ts';
import { promptFromContext } from '../../../../src/sandbox/guest-contract.ts';

describe('portable release verification in independent workspaces', () => {
	it('reproduces missing scratch destination and replays default npm pack in a fresh Reviewer workspace', async () => {
		const roots = await Promise.all([mkdtemp(join(tmpdir(),'treeseed-actor-pack-')),mkdtemp(join(tmpdir(),'treeseed-review-pack-'))]);
		try {
			for (const root of roots) await writeFile(join(root,'package.json'), JSON.stringify({ name:'treeseed-portable-pack-fixture',version:'1.0.0' }));
			await expect(run('npm',['pack','--pack-destination','.treeseed/release-pack'],{cwd:roots[1],timeoutMs:15000}))
				.rejects.toThrow('exited 254');
			const report = {schemaVersion:'treeseed.activity-completion/v1' as const,summary:'Local packaging',reviewDisposition:null,
				contentOutput:null,verification:[{status:'passed' as const,summary:'Package produced',commands:['npm pack']}]};
			for (const root of roots) {
				await verifyReportedActivityCommands(report, async command => { expect(command).toBe('npm pack'); await run('npm',['pack'],{cwd:root,timeoutMs:15000}); });
				const bytes = await readFile(join(root,'treeseed-portable-pack-fixture-1.0.0.tgz'));
				expect(bytes.subarray(0,2)).toEqual(Buffer.from([0x1f,0x8b]));
			}
		} finally { for (const root of roots) await rm(root,{recursive:true,force:true}); }
	}, 45000);
	it('guides both release Actor and Reviewer to independently verify ordinary current-directory packaging', () => {
		for (const [agentClass,activity] of [['releaser','acting'],['reviewer','reviewing']]) {
			const prompt = promptFromContext({canonicalAssignmentContext:{assignment:{agentClass,effectiveProfile:{activity,handler:agentClass==='releaser'?'releaser':'writer'},
				authorityRefs:[{model:'decision',id:'decision'}],acceptanceCriteria:['Pack the local release candidate.'],workItemId:'simulate-release',workspace:{mode:'git'}},source:{}}});
			expect(prompt).toContain('standalone command npm pack in /workspace/project');
			expect(prompt).toContain('default current-directory output');
			expect(prompt).toContain('repository-owned standalone archive verification command');
			expect(prompt).toContain('tarball packed in this workspace');
			expect(prompt).toContain('report the missing replayable check as an unmet criterion');
			expect(prompt).toContain('inspect their script composition');
			expect(prompt).toContain('Do not run a separate generator or full suite already owned by that aggregate gate');
		}
	});
});
