import { readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
const root = resolve(import.meta.dirname, '../../../../..');
describe('capacity-provider guarantee execution bindings', () => {
	it('binds installed owner custody to every original integrated SDK step without source-only execution credit', () => {
		const manifest = parse(readFileSync(resolve(root, 'guarantees/agent/golden/sdk-complete.guarantee.yaml'), 'utf8'));
		const scene = parse(readFileSync(resolve(root, manifest.scene.manifest), 'utf8'));
		const refs = scene.workflow.map((step: { action: { verifier: string } }) => step.action.verifier);
		expect(scene.scope).toBe('local-integrated-runtime'); expect(refs).toHaveLength(22); expect(new Set(refs).size).toBe(22);
		expect(manifest.acceptanceCriteria.filter((value: { criterion: string }) =>
			value.criterion === '6a572f1a5833a039bdc575588d8e6e272a0e71a29a5faaeeeb7b5c85d6544ee6')).toEqual([
			{ criterion: '6a572f1a5833a039bdc575588d8e6e272a0e71a29a5faaeeeb7b5c85d6544ee6', verifierRefs: refs },
		]);
		const workflow = parse(readFileSync(resolve(root, '.github/workflows/verify.yml'), 'utf8'));
		const native = workflow.jobs['installed-owner-custody'];
		expect(native).toBeDefined(); expect(native.needs).toBe('verify');
		expect(native.environment).toBeUndefined();
		expect(native.steps.filter((step: { with?: { repository?: string } }) => step.with?.repository === 'treeseed-ai/treedx')
			.map((step: { with: unknown }) => step.with)).toEqual([{ repository: 'treeseed-ai/treedx',
				ref: 'ba464cc2e276aaa4ad0f948b938984ad7263586e', path: '.treeseed/installed-owner-inputs/treedx-source', 'persist-credentials': false }]);
		expect(native.steps.some((step: { run?: string }) => step.run ===
			'node --import tsx ./scripts/support/verify-installed-owners.ts')).toBe(true);
		const inputs = JSON.parse(native.env.TREESEED_INSTALLED_OWNER_INPUTS);
        expect(inputs.find((value:{owner:string})=>value.owner==='deployment')).toMatchObject({commit:'e7cc4bebed7dbed0576fa5029250398f154f81aa',sha256:'05cc8823286e56ae35518d51189b1ee02fd060ebcb4d1a10e20ad7f28356d9c6'});
        expect(native.steps.filter((step:{with?:{repository?:string;path?:string}})=>step.with?.repository==='treeseed-ai/deployment'&&step.with?.path==='.treeseed/installed-owner-inputs/deployment').map((step:{with:unknown})=>step.with)).toEqual([{'github-token':'${{ github.token }}',repository:'treeseed-ai/deployment','run-id':38716691312,name:'deployment-candidate-e7cc4bebed7dbed0576fa5029250398f154f81aa',path:'.treeseed/installed-owner-inputs/deployment'}]);
        expect(inputs.find((value:{owner:string})=>value.owner==='sdk')).toMatchObject({commit:'557f2ca792a8958736791554b67640a67d62b860',sha256:'47c595d999c5b91514c60d5d3d81930aef5e06b6441b9c239c73e08b4810cfb6'});
        for(const [owner,runId] of [['api',38874118974],['cli',38647918411],['sdk',38858348626]] as const){
            const input=inputs.find((value:{owner:string})=>value.owner===owner);
            const downloads=native.steps.filter((step:{with?:{repository?:string;path?:string}})=>step.with?.repository==='treeseed-ai/'+owner&&step.with?.path==='.treeseed/installed-owner-inputs/'+owner);
            expect(downloads).toHaveLength(1);
            expect(downloads[0].with).toMatchObject({'run-id':runId,name:owner+'-'+input.commit});
        }

		expect(inputs.find((value: { owner: string }) => value.owner === 'cli')).toMatchObject({
			commit: '6e2579428f4959906cd5b9b669ebbb2b44cb495c', sha256: '49b6d24882af45ba39fd46cdcd999c9c54e84bd416f834fa0042ec5425dbea1a' });
		expect(inputs.find((value: { owner: string }) => value.owner === 'api')).toMatchObject({
			commit: '7daf0ba93c3bea63d03e69fb3c6d7a87e679f976', sha256: '3b3e9ed662e84b2cb1fa254f5aca1632738e411c1af3abfb5e2caffa93cfbd4d' });
		expect(inputs.find((value: { owner: string }) => value.owner === 'api').buildTreeDx).toEqual({
			commit: '6d358bb2e536af24918f3c33acb2072b9093a603', sha256: 'd6de27b42704b4c899562f290950561132fd0d48f38a95e6624eb853e32691cb' });
		expect(inputs.find((value: { owner: string }) => value.owner === 'api').buildSdk).toMatchObject({
			commit: '952195376b53bf39742e64f320f2a3b109cc77c0', sha256: '7ba46c788578f526692e81f3713f05e7c00db900b2d810ec27364cb41c008185' });
		expect(inputs.find((value: { owner: string }) => value.owner === 'reviewer').buildSdk).toMatchObject({
			commit: '77a6908d4e7580716e9e2ab92de80150b02cdb06', sha256: 'a31b02194665e8705e8d81331da0901f4088f54deb50a34c236d3a661d2d1aa7' });
		const rebuild = readFileSync(resolve(root, 'scripts/support/verify-installed-owners.ts'), 'utf8');
		expect(rebuild).toContain("else if (input.owner === 'cli')");
		expect(rebuild).toContain("scripts/build/hydrate-exact-sdk.ts");
		expect(rebuild).toContain('sdk.archiveSha256');
		const held = ['agent', 'api', 'sdk', 'cli', 'deployment', 'reviewer'].map(owner =>
			({ owner, commit: 'a'.repeat(40), sha256: owner === 'agent' ? null : 'b'.repeat(64) }));
		const malformed = [null, held.slice(1), [...held.slice(1), held[1]],
			held.map(value => value.owner === 'cli' ? { ...value, owner: '../cli' } : value),
			held.map(value => value.owner === 'cli' ? { ...value, commit: 'staging' } : value),
			held.map(value => value.owner === 'cli' ? { ...value, sha256: 'unheld' } : value),
			held.map(value => value.owner === 'cli' ? { ...value, buildSdk: { commit: 'staging', sha256: 'b'.repeat(64) } } : value),
			held.map(value => value.owner === 'cli' ? { ...value, buildSdk: { commit: 'a'.repeat(40), sha256: 'unheld' } } : value),
			held.map(value => value.owner === 'api' ? { ...value, buildTreeDx: { commit: 'staging', sha256: 'b'.repeat(64) } } : value),
			held.map(value => value.owner === 'api' ? { ...value, buildTreeDx: { commit: 'a'.repeat(40), sha256: 'unheld' } } : value)];
		const directory = mkdtempSync(resolve(tmpdir(), 'installed-input-denial-'));
		try {
			for (const input of malformed) {
				const result = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'),
					resolve(root, 'scripts/support/verify-installed-owners.ts')], { cwd: directory, encoding: 'utf8',
					env: { ...process.env, GITHUB_SHA: 'a'.repeat(40), TREESEED_INSTALLED_OWNER_INPUTS: JSON.stringify(input) } });
				expect(result.error).toBeUndefined(); expect(result.signal).toBeNull(); expect(result.status).toBe(1);
				expect(result.stderr).toContain('ERR_ASSERTION'); expect(readdirSync(directory)).toEqual([]);
			}
		} finally { rmSync(directory, { recursive: true, force: true }); }
	});
});
