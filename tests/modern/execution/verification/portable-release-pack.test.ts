import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../../../../src/sandbox/process-runner.ts';
import { verifyReportedActivityCommands } from '../../../../src/kernel/handlers/model-workload.ts';
import { promptFromContext } from '../../../../src/kernel/handlers/model-workload-contract.ts';

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
	it('keeps packaging instructions in the accepted profile instead of inferring them from role names', () => {
 for (const activity of ['acting','reviewing']) {
  const prompt = promptFromContext({ canonicalAssignmentContext: { assignment: { agentClass: 'releaser', authorityRefs: [{model:'decision'}], effectiveProfile: { activity, handler: 'releaser', prompt: { system: 'Review the accepted interface change.' } }, acceptanceCriteria: ['Prepare this change for release.'] } } });
  expect(prompt).not.toContain('standalone command npm pack');
  expect(prompt).not.toContain('tarball packed in this workspace');
 }
});
});
