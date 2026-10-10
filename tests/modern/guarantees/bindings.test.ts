import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../../..');
type Verifier = { kind: string; testFile?: string; testName?: string; command?: string };
const registry: { verifiers: Record<string, Verifier> } = { verifiers: {} };
for (const file of readdirSync(resolve(root, 'guarantees/verifiers')).filter(path => path.endsWith('.verifiers.yaml'))) {
	const document = parse(readFileSync(resolve(root, 'guarantees/verifiers', file), 'utf8')) as { verifiers: Record<string, Verifier> };
	for (const [id, definition] of Object.entries(document.verifiers)) {
		if (registry.verifiers[id]) throw new Error(`Duplicate guarantee verifier ${id}`);
		registry.verifiers[id] = definition;
	}
}

describe('capacity-provider guarantee execution bindings', () => {
	it('binds exact six-pair graph and Reporter chronology requirements to their existing post-campaign native gates', () => {
		const manifest = parse(readFileSync(resolve(root, 'guarantees/agent/golden/sdk-complete.guarantee.yaml'), 'utf8'));
		const scene = parse(readFileSync(resolve(root, manifest.scene.manifest), 'utf8'));
		const refs: string[] = scene.workflow.map((step: { action: { verifier: string } }) => step.action.verifier);
		for (const [criterion, ref, testName] of [
			['6d6749cd8c2676c6c50c009b55025ec3b951589db602440f63b76ba021159f20', 'agent.golden.live.graph', 'Golden runtime graph evidence satisfies its acceptance boundary'],
			['3bf7f808c3baf5cc63fc5e8e8c065bc2cd87dea9e2df9aae4d1924565af6acd8', 'agent.golden.live.reporter', 'Golden runtime reporter evidence satisfies its acceptance boundary'],
		]) {
			expect(manifest.acceptanceCriteria.filter((value: { criterion: string }) => value.criterion === criterion))
				.toEqual([{ criterion, verifierRefs: [ref] }]);
			expect(registry.verifiers[ref]).toMatchObject({ kind: 'nodeTestCase', testFile: 'tests/acceptance/sdk-runtime-golden.test.ts', testName });
			expect(refs.filter(value => value === ref)).toHaveLength(1);
			expect(refs.indexOf(ref)).toBeGreaterThan(refs.indexOf('agent.golden.live.campaign'));
		}
	});
	it('binds the exact model clock criterion to complete post campaign native readback without substituting component evidence', () => {
		const manifest = parse(readFileSync(resolve(root, 'guarantees/agent/golden/sdk-complete.guarantee.yaml'), 'utf8'));
		const prospectiveInputs = [
			'5a286ca84dffc7ea229c2035a106c26aa0f8fe4e78da3cb035b1bc4859810e95',
			'1dd6f762ce6507847246f790bf57d735bcefe27c21bf8338a179dddbe3d0f930',
			'ee31029693c8c8c0e9e1b8506a341cbb4ddbc15c585cf16de713dc540f68bf55',
			'70a2f58978eb3f6f32b214260bc87ac3ebfe11060c801f179bfc75da2d06e2ef',
			'a36454b4c07f4f736d412c1839e5cc095481697b65a27b757515fabd34172203',
			'c7a791cfb40d560a846fca80c0e59258b7793e0bd57499b43d9f61df3d2e9b41',
			'3b816289341ea3e179c9e4b75392cff59c7fb254580e63c92c87d96b8a5223db',
			'98984bf7e8b6f1b04e3e994888be21daf1d224eb367d95a0849cd5f6dd94f2a5',
			'b53c04085fa78d71c15f32d94f32b925c316f404a67328a466887cd3d9f34c95',
			'b1862b020ba7f70a9154abe27dc0a6466030dc0d6b3f63f34bdd0485e8a3feba',
			'7df1b6212ad765c7c8538b57df69150c60b7ac8fa19242111963da6f90b2c088',
			'673111d5d0ef3029b0b7bc57eccf0515b661cdaf615ffc0206aa3d085a80f1d5',
			'117e7a5900a48c54a4d536d71de49708dacf59fe52aa27a7ff8c67b4d17d5c16',
			'962cf6428dc2cdd1f720d29bbb68abf250cfbbfe128ac4c79d7f5aee7b6e661a',
			'f29da4387b40305b08caaf15b955526cd99c97df4117eec47d40257d48900157',
			'f86cab61d39ea7f46fb9171c3d75a5e547b256cedd6ec5ca6c480ae26822ef26',
			'67be60c1ce8993d62e20243cf53359ceaf58ab1d8866589af00cae11cb12e295',
			'772870fb89c0c04ea930fb424cc66a0a057131849b5ba8b59f9d1f0da8e48567',
			'bff803652752fed25c48491f7eb474367fd2c061801612238e24f29037db2424',
			'7f4f6bb99633197d6e94efa969cf8fa2da8f65e559aeb22da5707a8fb82c4265',
			'b918b519ac545fdd61faab208687ccc64e1f3d03c9a84dfc57a5cfee6190f3f3',
		].map(criterion => ({ criterion, verifierRefs: ['agent.golden.live.campaign-freeze'] }));
		expect(manifest.acceptanceCriteria).toEqual([{ criterion: 'b635827ed7862d56b8764dfad30114b9ee18d02b4aa709a257841e18a1bd0f0d',
			verifierRefs: ['agent.golden.execution-clock-observation-live-1'] },
			{ criterion: '7eaf9fdc1c264e2d0b28d2fc751da33a2ffcf98ca0d6446ac6e8672503dfa533',
				verifierRefs: ['agent.golden.live.reporter', 'agent.golden.live.settlement'] }, ...prospectiveInputs,
			{ criterion: '80496650a6ed5888fbda21ddcb15047d221874adb709887306dede9e3e93ff55', verifierRefs: ['agent.golden.live.results'] },
			{ criterion: '6d6749cd8c2676c6c50c009b55025ec3b951589db602440f63b76ba021159f20', verifierRefs: ['agent.golden.live.graph'] },
			{ criterion: '3bf7f808c3baf5cc63fc5e8e8c065bc2cd87dea9e2df9aae4d1924565af6acd8', verifierRefs: ['agent.golden.live.reporter'] }]);
		const scene = parse(readFileSync(resolve(root, manifest.scene.manifest), 'utf8'));
		expect(scene.scope).toBe('local-integrated-runtime');
		const refs = scene.workflow.map((step: { action: { verifier: string } }) => step.action.verifier);
		expect(refs.filter((ref: string) => ref === 'agent.golden.live.campaign-freeze')).toHaveLength(1);
		expect(refs.indexOf('agent.golden.live.campaign-freeze')).toBeLessThan(refs.indexOf('agent.golden.live.campaign'));
		expect(registry.verifiers['agent.golden.live.campaign-freeze']).toMatchObject({ kind: 'nodeTestCase',
			testFile: 'tests/acceptance/freeze-integrity.test.ts',
			testName: 'Golden pre-run campaign freeze retains every schema-valid expanded input and original manifest bytes before SDK execution' });
		expect(refs.filter((ref: string) => ref === 'agent.golden.execution-clock-observation-live-1')).toHaveLength(1);
		expect(refs.indexOf('agent.golden.live.campaign')).toBeGreaterThan(-1);
		expect(refs.filter((ref: string) => ref === 'agent.golden.live.results')).toHaveLength(1);
		expect(refs.indexOf('agent.golden.live.results')).toBeGreaterThan(refs.indexOf('agent.golden.live.campaign'));
		expect(registry.verifiers['agent.golden.live.results']).toMatchObject({ kind: 'nodeTestCase',
			testFile: 'tests/acceptance/sdk-runtime-golden.test.ts', testName: 'Golden runtime results evidence satisfies its acceptance boundary' });
		expect(refs.indexOf('agent.golden.execution-clock-observation-live-1')).toBeGreaterThan(refs.indexOf('agent.golden.live.campaign'));
		for (const ref of ['agent.golden.live.reporter', 'agent.golden.live.settlement']) {
			expect(refs.filter((value: string) => value === ref)).toHaveLength(1);
			expect(refs.indexOf(ref)).toBeGreaterThan(refs.indexOf('agent.golden.live.campaign'));
			expect(registry.verifiers[ref]).toMatchObject({ kind: 'nodeTestCase', testFile: 'tests/acceptance/sdk-runtime-golden.test.ts' });
		}
		expect(registry.verifiers['agent.golden.execution-clock-observation-live-1']).toMatchObject({ kind: 'nodeTestCase',
			testFile: 'tests/acceptance/workday/context-custody.test.ts',
			testName: 'Every actual recorded model execution is included in exact clock evidence readback without discarding failed or returned attempts' });
	});
	it('selects existing normal SDK profile context graph and canonical-record readbacks after the same lifecycle without requiring controlled failures or continuation',()=>{
  const manifest=parse(readFileSync(resolve(root,'guarantees/agent/golden/sdk-complete.guarantee.yaml'),'utf8'));
  const scene=parse(readFileSync(resolve(root,manifest.scene.manifest),'utf8'));
  expect(scene.scope).toBe('local-integrated-runtime');
  const refs:string[]=scene.workflow.map((step:{action:{verifier:string}})=>step.action.verifier);
  for(const ref of ['agent.golden.architecture-profile-custody-live-1','agent.golden.architecture-profile-custody-live-2',
   'agent.golden.architecture-context-custody-live-1','agent.golden.architecture-book-knowledge-live-1',
   'agent.golden.architecture-graph-history-live-1','agent.golden.architecture-record-custody-live-1']) {
   expect(refs.filter(value=>value===ref),ref).toHaveLength(1);
   expect(refs.indexOf(ref),ref).toBeGreaterThan(refs.indexOf('agent.golden.live.campaign'));
   expect(registry.verifiers[ref]).toMatchObject({kind:'nodeTestCase'});
  }
  for(const ref of refs)expect(registry.verifiers[ref]?.testName??'',ref).not.toMatch(/controlled|continuation|completed and failed/u);
 });
	it('supplies exact canonical execution authority before complete verification and inherited scene prerequisites', () => {
		const workflow = parse(readFileSync(resolve(root, '.github/workflows/verify.yml'), 'utf8'));
		const job = workflow.jobs.verify, steps = job.steps;
		const checkouts = steps.filter((step: { uses?: string; with?: { repository?: string } }) =>
			step.uses?.startsWith('actions/checkout@') && step.with?.repository === 'treeseed-ai/platform');
		expect(checkouts).toHaveLength(1);
		expect(checkouts[0].with).toMatchObject({ ref: 'e4c4cad1e526f53d3549c8fc27c3e60122b20ee4', path: '.treeseed/platform-authority', 'persist-credentials': false });
		expect(job.env.TREESEED_DEVELOPMENT_WORKSPACE_ROOT).toBe('${{ github.workspace }}/.treeseed/platform-authority');
		const verify = steps.findIndex((step: { run?: string }) => step.run?.includes('npm run verify:local'));
		const scene = steps.findIndex((step: { uses?: string }) => step.uses?.includes('reviewer/.github/actions/run-scenes@'));
		expect(steps[scene].uses).toBe('treeseed-ai/reviewer/.github/actions/run-scenes@879c7406582b0d7da4dcdcd5356ec21daa286662');
		expect(steps.indexOf(checkouts[0])).toBeLessThan(verify); expect(verify).toBeGreaterThan(-1); expect(scene).toBeGreaterThan(verify);
		const relay = steps.findIndex((step: { name?: string }) => step.name === 'Prepare disposable native relay CA');
		expect(relay).toBeGreaterThan(-1); expect(relay).toBeLessThan(verify);
		expect(steps[relay].run).toContain('openssl x509 -in "$relay_fixture/ca.pem" -noout -checkend 0');
		expect(steps[relay].run).toContain('sudo install -m 0644 "$relay_fixture/ca.pem" /etc/treeseed/sandbox/relay-ca.crt');
	});
	it('binds every registered verifier to an executable current implementation', () => {
		const failures: string[] = [];
		const namesByFile = new Map<string, string[]>();
		for (const [id, verifier] of Object.entries(registry.verifiers)) {
			const path = ['vitestCase', 'nodeTestCase'].includes(verifier.kind) ? verifier.testFile : verifier.command;
			if (!path || !existsSync(resolve(root, path))) {
				failures.push(`${id}: missing ${path ?? 'implementation'}`);
				continue;
			}
			if (['vitestCase', 'nodeTestCase'].includes(verifier.kind)) {
				if (verifier.kind === 'vitestCase' && !path.startsWith('tests/modern/')) failures.push(`${id}: excluded from the active Vitest suite`);
				if (verifier.kind === 'nodeTestCase' && !path.startsWith('tests/acceptance/')) failures.push(`${id}: not an explicit runtime acceptance test`);
				let names = namesByFile.get(path);
				if (!names) {
				const source = ts.createSourceFile(path, readFileSync(resolve(root, path), 'utf8'), ts.ScriptTarget.Latest, true);
				const collected: string[] = [];
				function inspect(node: ts.Node): void {
					if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
						&& ['it', 'test'].includes(node.expression.text) && node.arguments[0]
						&& ts.isStringLiteral(node.arguments[0])) collected.push(node.arguments[0].text);
					ts.forEachChild(node, inspect);
				}
				inspect(source);
				names = collected; namesByFile.set(path, names);
				}
				if (!verifier.testName || !names.includes(verifier.testName)) failures.push(`${id}: missing active named case ${verifier.testName ?? '(unspecified)'}`);
			}
		}
		expect(failures, failures.join('\n')).toEqual([]);
	});
	it('resolves every guarantee verifier reference without silently ignoring planned contracts', () => {
		const failures: string[] = [];
		function visit(directory: string): void {
			for (const entry of readdirSync(directory, { withFileTypes: true })) {
				const path = resolve(directory, entry.name);
				if (entry.isDirectory()) visit(path);
				else if (entry.name.endsWith('.scene.yaml')) {
					const scene = parse(readFileSync(path, 'utf8')) as { scope?: string; workflow?: Array<{
						id?: string; demoOnly?: boolean; action?: { verifier?: string }; expect?: { status?: string } }> };
					if (!['local-component-tests', 'local-integrated-runtime'].includes(scene.scope ?? '')) continue;
					if (!scene.workflow?.length) { failures.push(`${path}: empty executable scene`); continue; }
					const ids = new Set<string>();
					for (const step of scene.workflow) {
						if (!step.id || ids.has(step.id) || step.demoOnly || !step.action?.verifier
							|| step.expect?.status !== 'passed') {
							failures.push(`${path}: invalid executable step ${step.id ?? '(missing)'}`);
						}
						if (step.id) ids.add(step.id);
					}
				}
				else if (entry.name.endsWith('.guarantee.yaml')) {
					const guarantee = parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
					function references(value: unknown): void {
						if (!value || typeof value !== 'object') return;
						for (const [key, child] of Object.entries(value)) {
							if (key === 'verifierRefs' && Array.isArray(child)) {
								for (const id of child) if (typeof id !== 'string' || !registry.verifiers[id])
									failures.push(`${guarantee.id}: unregistered ${String(id)}`);
							} else references(child);
						}
					}
					 references(guarantee);
				}
			}
		}
		visit(resolve(root, 'guarantees'));
		expect([...new Set(failures)], [...new Set(failures)].join('\n')).toEqual([]);
	});
});
