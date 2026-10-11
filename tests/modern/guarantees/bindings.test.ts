import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../../..');
const sdkFixedGraphCriteria = [
	'e2bf7c70f63b2f4d1532a2d9c62fd7d5b4305151bcadc9c650a3a48bcd8649e7',
	'47b521b0831f30babf7664f8e12de9b9336a9c949de98473e1767212d7a76cd2',
	'95e989b76535f28f68527b4e3cf57ca49437695c9f97c57acdfca81d2f62055a',
	'96a6b0f3ae0587119f592e97fc93efdaae676674a34fb9e9511fd0a9a044fd6e',
	'11dc8f94be641ad4a78110ac48b1a33144ab46b5a4faac7b3eba1c3873360ec6',
	'9aa7395c3dc83d555538ad7b6ecfa3d307744044bab0de0574731218ca2e7710',
	'ae904659a63c9d7478fecc4ba97674ff617e9aee8e0d4e2c3aa96ce1eb16a7cd',
	'a36158a2e8f122136ece95b41cfd72c345beefa609df5ec27e296b56e77de930',
];
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
		const product = 'sdk.golden.live.product';
		for (const criterion of ['9a9b626b666f555139baf8aabcead659ca30e7f88ad8002f73f2b35ddf542ad4',
			'8fc0d803455b8e437a458732d5b6ba575f885eb35ba387e93e14230dd40d27b7',
			...sdkFixedGraphCriteria,
			'4f295a5342aaf08b1ca056a5aa8bc00df27a07cf116b6721b6179d575c6b76df']) {
			expect(manifest.acceptanceCriteria.filter((value: { criterion: string }) => value.criterion === criterion))
				.toEqual([{ criterion, verifierRefs: [product] }]);
		}
		expect(refs.filter(value => value === product)).toHaveLength(1);
		expect(refs.indexOf(product)).toBeGreaterThan(refs.indexOf('agent.golden.live.campaign'));
		// SDK owns the semantic assertions and native integration; do not copy its verifier here.
		expect(registry.verifiers[product]).toBeUndefined();
		const book = 'agent.golden.architecture-book-knowledge-live-1';
		expect(manifest.acceptanceCriteria.filter((value: { criterion: string }) =>
			value.criterion === '936013d37582fbedab56e17601be3581682b72565d8b7fdaedb75f6a3cd2e64f'))
			.toEqual([{ criterion: '936013d37582fbedab56e17601be3581682b72565d8b7fdaedb75f6a3cd2e64f',
				verifierRefs: ['agent.golden.live.campaign', book] }]);
		expect(refs.filter(value => value === book)).toHaveLength(1);
		expect(refs.indexOf(book)).toBeGreaterThan(refs.indexOf('agent.golden.live.campaign'));
		const issuance = ['api.golden.execution-normal-sdk-clean-schema-live-1',
			'agent.golden.architecture-record-custody-live-1'];
		expect(manifest.acceptanceCriteria.filter((value: { criterion: string }) =>
			value.criterion === '22f329d858029233d66c747de963c8ac14c8655b0fe536ee1921ec39101ca1b8'))
			.toEqual([{ criterion: '22f329d858029233d66c747de963c8ac14c8655b0fe536ee1921ec39101ca1b8', verifierRefs: issuance }]);
		for (const ref of issuance) {
			expect(refs.filter(value => value === ref)).toHaveLength(1);
			expect(refs.indexOf(ref)).toBeGreaterThan(refs.indexOf('agent.golden.live.campaign'));
		}
		expect(registry.verifiers[issuance[0]!]).toBeUndefined();
		expect(registry.verifiers[issuance[1]!]).toMatchObject({ kind: 'nodeTestCase',
			testFile: 'tests/acceptance/workday/record-custody.test.ts',
			testName: 'Every native managed attempt exposes one unchanged canonical lease reservation result and UsageSettlement across public views' });
		for (const criterion of ['6e8f096457026f1992cb08a4e36f02a7c5b55b472e7019ff615866256fac85d2',
			'2b8cb6c3b6c1014b10ea1263a4e5f0aea2a1b93ae71ec69a0abbb410b304fab1',
			'0cb616106a09f5279323a975d315c59ebefb6e5e0db2ef52e153c0995038158f',
			'f02eb0d95e0572b52f73700b689cd584d9ae57a880ca5658546c1cae44b535e4'])
			expect(manifest.acceptanceCriteria.filter((value: { criterion: string }) => value.criterion === criterion))
				.toEqual([{ criterion, verifierRefs: ['agent.golden.live.campaign', product] }]);
	});
	it('binds the exact model clock criterion to complete post campaign native readback without substituting component evidence', () => {
		const manifest = parse(readFileSync(resolve(root, 'guarantees/agent/golden/sdk-complete.guarantee.yaml'), 'utf8'));
		const preRunBindings = [
			'5a286ca84dffc7ea229c2035a106c26aa0f8fe4e78da3cb035b1bc4859810e95',
			'ab2ac9ce3bbbf837b5c65b9b6246aa6850713b4d82fc15c52d590144dd265a0b',
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
		expect(manifest.acceptanceCriteria).toEqual([
			...sdkFixedGraphCriteria.map(criterion => ({ criterion, verifierRefs: ['sdk.golden.live.product'] })),
			{ criterion: 'b635827ed7862d56b8764dfad30114b9ee18d02b4aa709a257841e18a1bd0f0d',
			verifierRefs: ['agent.golden.execution-clock-observation-live-1', 'api.golden.execution-protected-observation-live-1'] },
			{ criterion: '7eaf9fdc1c264e2d0b28d2fc751da33a2ffcf98ca0d6446ac6e8672503dfa533',
				verifierRefs: ['agent.golden.live.reporter', 'agent.golden.live.settlement'] }, ...preRunBindings,
			{ criterion: '80496650a6ed5888fbda21ddcb15047d221874adb709887306dede9e3e93ff55', verifierRefs: ['agent.golden.live.results'] },
			{ criterion: '6d6749cd8c2676c6c50c009b55025ec3b951589db602440f63b76ba021159f20', verifierRefs: ['agent.golden.live.graph'] },
			{ criterion: '3bf7f808c3baf5cc63fc5e8e8c065bc2cd87dea9e2df9aae4d1924565af6acd8', verifierRefs: ['agent.golden.live.reporter'] },
			{ criterion: '9a9b626b666f555139baf8aabcead659ca30e7f88ad8002f73f2b35ddf542ad4', verifierRefs: ['sdk.golden.live.product'] },
			{ criterion: '8fc0d803455b8e437a458732d5b6ba575f885eb35ba387e93e14230dd40d27b7', verifierRefs: ['sdk.golden.live.product'] },
			{ criterion: '936013d37582fbedab56e17601be3581682b72565d8b7fdaedb75f6a3cd2e64f',
				verifierRefs: ['agent.golden.live.campaign', 'agent.golden.architecture-book-knowledge-live-1'] },
			{ criterion: '4f295a5342aaf08b1ca056a5aa8bc00df27a07cf116b6721b6179d575c6b76df',
				verifierRefs: ['sdk.golden.live.product'] },
			{ criterion: '22f329d858029233d66c747de963c8ac14c8655b0fe536ee1921ec39101ca1b8',
				verifierRefs: ['api.golden.execution-normal-sdk-clean-schema-live-1', 'agent.golden.architecture-record-custody-live-1'] },
			{ criterion: '6e8f096457026f1992cb08a4e36f02a7c5b55b472e7019ff615866256fac85d2',
				verifierRefs: ['agent.golden.live.campaign', 'sdk.golden.live.product'] },
			{ criterion: '0cb616106a09f5279323a975d315c59ebefb6e5e0db2ef52e153c0995038158f',
				verifierRefs: ['agent.golden.live.campaign', 'sdk.golden.live.product'] },
			{ criterion: 'f02eb0d95e0572b52f73700b689cd584d9ae57a880ca5658546c1cae44b535e4',
				verifierRefs: ['agent.golden.live.campaign', 'sdk.golden.live.product'] },
			{ criterion: '2b8cb6c3b6c1014b10ea1263a4e5f0aea2a1b93ae71ec69a0abbb410b304fab1',
				verifierRefs: ['agent.golden.live.campaign', 'sdk.golden.live.product'] }]);
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
		const protectedClock = 'api.golden.execution-protected-observation-live-1';
		expect(refs.filter((ref: string) => ref === protectedClock)).toHaveLength(1);
		expect(refs.indexOf(protectedClock)).toBeGreaterThan(refs.indexOf('agent.golden.execution-clock-observation-live-1'));
		expect(refs).not.toContain('api.golden.execution-unfinished-handoff-live-1');
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
  const schemaRef='api.golden.execution-normal-sdk-clean-schema-live-1';
  expect(refs.filter(value=>value===schemaRef)).toHaveLength(1);
  expect(refs.indexOf(schemaRef)).toBeGreaterThan(refs.indexOf('agent.golden.architecture-record-custody-live-1'));
  expect(refs.indexOf(schemaRef)).toBeLessThan(refs.indexOf('agent.golden.execution-normal-sdk-physical-absence-live-1'));
  expect(refs).not.toContain('api.golden.execution-clean-schema-live-1');
  // Reuse this selected binding case; API owns the actual public/native proof.
  // Independent Agent discovery must not duplicate API's verifier definition.
  expect(registry.verifiers[schemaRef]).toBeUndefined();
  for(const ref of ['agent.golden.architecture-profile-custody-live-1','agent.golden.architecture-profile-custody-live-2',
   'agent.golden.architecture-context-custody-live-1','agent.golden.architecture-book-knowledge-live-1',
   'agent.golden.architecture-graph-history-live-1','agent.golden.architecture-record-custody-live-1',
   'agent.golden.execution-normal-sdk-physical-absence-live-1']) {
   expect(refs.filter(value=>value===ref),ref).toHaveLength(1);
   expect(refs.indexOf(ref),ref).toBeGreaterThan(refs.indexOf('agent.golden.live.campaign'));
   expect(registry.verifiers[ref]).toMatchObject({kind:'nodeTestCase'});
  }
  const cliRef='cli.golden.execution-diagnostics-read-native';
  expect(refs.filter(ref=>ref===cliRef)).toHaveLength(1);
  expect(refs.indexOf(cliRef)).toBeLessThan(refs.indexOf('agent.golden.live.campaign'));
  // The workspace runner resolves this existing CLI-owned native definition;
  // Agent's independent suite must not require another source checkout.
  for(const ref of refs.filter(value=>value!==cliRef))expect(registry.verifiers[ref]?.testName??'',ref)
   .not.toMatch(/controlled|continuation|completed and failed/u);
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
		expect(steps[scene].uses).toBe('treeseed-ai/reviewer/.github/actions/run-scenes@e60ad2581e7ff041f058af04bd810796fea748f9');
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
					const scenePath = (guarantee.scene as { manifest?: string } | undefined)?.manifest;
					const scene = scenePath ? parse(readFileSync(resolve(root, scenePath), 'utf8')) : undefined;
					const selected: string[] = scene?.workflow?.map((step: { action: { verifier: string } }) => step.action.verifier) ?? [];
					function references(value: unknown): void {
						if (!value || typeof value !== 'object') return;
						for (const [key, child] of Object.entries(value)) {
							if (key === 'verifierRefs' && Array.isArray(child)) {
								// Cross-package definitions are resolved by the workspace Reviewer.
								// Independent Agent tests still require an exact selected scene ref.
								for (const id of child) if (typeof id !== 'string' || (!registry.verifiers[id]
									&& (id.startsWith('agent.') || !selected.includes(id))))
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
