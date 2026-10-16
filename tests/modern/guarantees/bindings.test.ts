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
const sdkPermissionCriteria = [
	'5225ed550726fbcb844fa46c968221c6aa84e694f477dbec024a2c62604e6e5e',
	'bb1e425861ce6c4e6e61ed4f2eeaa39cbcb87cb621edc8e0d10dba4cf82ab681',
	'210c4c11e3c7150e04ba6c29bdab3ad6277418567fb0db8c6b7c342c13cdd897',
	'a213575995fddb824b0b28283bf4cd9532b73b573da57ac3c492aa9aea00bcdc',
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
	it('binds final integration to native approved source trees canonical reviews and protected public command observations', () => {
		const manifest = parse(readFileSync(resolve(root, 'guarantees/agent/golden/sdk-complete.guarantee.yaml'), 'utf8'));
		const scene = parse(readFileSync(resolve(root, manifest.scene.manifest), 'utf8'));
		const refs = ['sdk.golden.live.product', 'agent.golden.architecture-living-graph-live-1', 'api.golden.execution-protected-observation-live-1'];
		for(const binding of [{"criterion":"97bb37f205e9510f31ac55a03fc054f8be43b2994bd1eeef50cc9623f4c07b2f","verifierRefs":["sdk.golden.live.product","agent.golden.architecture-living-graph-live-1","api.golden.execution-protected-observation-live-1","api.golden.execution-normal-sdk-clean-schema-live-1"]},{"criterion":"736512f0456c2e9355139858303c36bcc227e265bc5b1fef907031a131cef283","verifierRefs":["sdk.golden.live.product","agent.golden.architecture-living-graph-live-1","api.golden.execution-protected-observation-live-1","api.golden.execution-normal-sdk-clean-schema-live-1"]}])expect.soft(manifest.acceptanceCriteria.filter((value:{criterion:string})=>value.criterion===binding.criterion)).toEqual([binding]);
		for(const ref of ["sdk.golden.live.product","agent.golden.architecture-living-graph-live-1","api.golden.execution-protected-observation-live-1","api.golden.execution-normal-sdk-clean-schema-live-1"])expect(scene.workflow.filter((step:{action:{verifier:string}})=>step.action.verifier===ref)).toHaveLength(1);
		expect(manifest.acceptanceCriteria.filter((value:{criterion:string})=>value.criterion==="4eed8913d17a59d22abba957017b7f7d41a39c9818da05081950ce169b8a52f4")).toEqual([{"criterion":"4eed8913d17a59d22abba957017b7f7d41a39c9818da05081950ce169b8a52f4","verifierRefs":["agent.golden.live.campaign","agent.golden.architecture-record-custody-live-1","agent.golden.live.settlement","api.golden.execution-normal-sdk-clean-schema-live-1"]}]);
		for(const ref of ["agent.golden.live.campaign","agent.golden.architecture-record-custody-live-1","agent.golden.live.settlement","api.golden.execution-normal-sdk-clean-schema-live-1"])expect(scene.workflow.filter((step:{action:{verifier:string}})=>step.action.verifier===ref)).toHaveLength(1);
		expect(manifest.acceptanceCriteria.filter((value:{criterion:string})=>value.criterion==='3b1b0b3e69460a27e2e322fab6c989a2d9928a6229b3820ac174a557b21f0122')).toEqual([{"criterion":"3b1b0b3e69460a27e2e322fab6c989a2d9928a6229b3820ac174a557b21f0122","verifierRefs":["agent.golden.live.campaign","agent.golden.live.campaign-freeze","agent.golden.architecture-profile-custody-live-1","agent.golden.architecture-context-custody-live-1","agent.golden.architecture-record-custody-live-1","api.golden.execution-protected-observation-live-1","api.golden.execution-normal-sdk-clean-schema-live-1"]}]);
		for(const ref of ["agent.golden.live.campaign","agent.golden.live.campaign-freeze","agent.golden.architecture-profile-custody-live-1","agent.golden.architecture-context-custody-live-1","agent.golden.architecture-record-custody-live-1","api.golden.execution-protected-observation-live-1","api.golden.execution-normal-sdk-clean-schema-live-1"])expect(scene.workflow.filter((step:{action:{verifier:string}})=>step.action.verifier===ref)).toHaveLength(1);
		// Research proof consumes actual native source and original governed revisions in the existing product gate.
		for(const binding of [{"criterion":"8cca846b891a94358f5b14d10ce2b347fc68e66d23fb7b9b4f6400495c2e29e4","verifierRefs":["sdk.golden.live.product","agent.golden.live.campaign","agent.golden.architecture-profile-custody-live-1","agent.golden.architecture-context-custody-live-1","agent.golden.architecture-living-graph-live-1","api.golden.execution-protected-observation-live-1"]},{"criterion":"7592ca5bb190bdbb0076c2ece19a0b35f2697f32555557ada2255cfa40afb690","verifierRefs":["sdk.golden.live.product","agent.golden.live.campaign","agent.golden.architecture-profile-custody-live-1","agent.golden.architecture-context-custody-live-1","agent.golden.architecture-living-graph-live-1","api.golden.execution-protected-observation-live-1"]}])expect(manifest.acceptanceCriteria.filter((value:{criterion:string})=>value.criterion===binding.criterion)).toEqual([binding]);
		for(const ref of ["sdk.golden.live.product","agent.golden.live.campaign","agent.golden.architecture-profile-custody-live-1","agent.golden.architecture-context-custody-live-1","agent.golden.architecture-living-graph-live-1","api.golden.execution-protected-observation-live-1"])expect(scene.workflow.filter((step:{action:{verifier:string}})=>step.action.verifier===ref)).toHaveLength(1);
		expect(manifest.acceptanceCriteria.filter((value:{criterion:string})=>value.criterion==='9e12c2ff2b78f2ad7f30476027cb34e5c34c9285b0d2b0324427c260fddb71bd')).toEqual([{"criterion":"9e12c2ff2b78f2ad7f30476027cb34e5c34c9285b0d2b0324427c260fddb71bd","verifierRefs":["agent.golden.live.campaign","agent.golden.architecture-graph-history-live-1","agent.golden.architecture-living-graph-live-1","agent.golden.architecture-record-custody-live-1"]}]);
		for(const ref of ["agent.golden.live.campaign","agent.golden.architecture-graph-history-live-1","agent.golden.architecture-living-graph-live-1","agent.golden.architecture-record-custody-live-1"])expect(scene.workflow.filter((step:{action:{verifier:string}})=>step.action.verifier===ref)).toHaveLength(1);
		// Exact classed proposal approval reuses the selected genuine-estimate and original content guards.
		expect(manifest.acceptanceCriteria.filter((value:{criterion:string})=>value.criterion==='c7bb1b569687ae6865ce03f335cf18c0b089e82561ef105f61ce3a188f3ca15d')).toEqual([{"criterion":"c7bb1b569687ae6865ce03f335cf18c0b089e82561ef105f61ce3a188f3ca15d","verifierRefs":["agent.golden.live.campaign","agent.golden.live.campaign-freeze","agent.golden.architecture-profile-custody-live-1","agent.golden.architecture-context-custody-live-1","agent.golden.architecture-record-custody-live-1","api.golden.execution-protected-observation-live-1","api.golden.execution-normal-sdk-clean-schema-live-1"]}]);
		for(const ref of ["agent.golden.live.campaign","agent.golden.live.campaign-freeze","agent.golden.architecture-profile-custody-live-1","agent.golden.architecture-context-custody-live-1","agent.golden.architecture-record-custody-live-1","api.golden.execution-protected-observation-live-1","api.golden.execution-normal-sdk-clean-schema-live-1"])expect(scene.workflow.filter((step:{action:{verifier:string}})=>step.action.verifier===ref)).toHaveLength(1);
		expect(manifest.acceptanceCriteria.filter((value:{criterion:string})=>value.criterion==="d5b3bcb8ef18cbdc71fb2cad6fd4a5a4d38a4e203f841050918a824f8676e1bd")).toEqual([{"criterion":"d5b3bcb8ef18cbdc71fb2cad6fd4a5a4d38a4e203f841050918a824f8676e1bd","verifierRefs":["agent.golden.live.campaign","agent.golden.architecture-profile-custody-live-1","agent.golden.architecture-context-custody-live-1","api.golden.execution-normal-sdk-clean-schema-live-1"]}]);
		expect(manifest.acceptanceCriteria.filter((value:{criterion:string})=>value.criterion==='d00910e63c8f4df319158d8a692499648dc88c7c01699fd6c175696de27fa41f')).toEqual([{criterion:'d00910e63c8f4df319158d8a692499648dc88c7c01699fd6c175696de27fa41f',verifierRefs:['agent.golden.live.campaign']}]);
		expect(manifest.acceptanceCriteria.filter((value: { criterion: string }) =>
			value.criterion === '5ac90e451b0365ff6c44bfbcde86252eb1b53adf6b97972d00a7d5f15b9bf0e9')).toEqual([
			{ criterion: '5ac90e451b0365ff6c44bfbcde86252eb1b53adf6b97972d00a7d5f15b9bf0e9', verifierRefs: refs },
		]);
		for (const ref of refs) expect(scene.workflow.filter((step: { action: { verifier: string } }) => step.action.verifier === ref)).toHaveLength(1);
		expect(manifest.acceptanceCriteria.filter((value: { criterion: string }) => value.criterion ===
			'a4199e48998233b28a6aa7480d4a386c32675970f2989ad2719240055fa91443')).toEqual([{
			criterion: 'a4199e48998233b28a6aa7480d4a386c32675970f2989ad2719240055fa91443', verifierRefs: [refs[0], refs[2]] }]);
		expect(manifest.acceptanceCriteria.filter((value: { criterion: string }) => value.criterion ===
			'ee95f7eb3323545534ac708f6ef6ae9d6b9ae2ae40ad4268738084a25d293d86')).toEqual([{ criterion: 'ee95f7eb3323545534ac708f6ef6ae9d6b9ae2ae40ad4268738084a25d293d86', verifierRefs: [refs[0], refs[1]] }]);
		const products = ['agent.golden.live.results', 'sdk.golden.live.product', 'agent.golden.live.reporter', 'api.golden.execution-normal-sdk-clean-schema-live-1'];
		expect(manifest.acceptanceCriteria.filter((value: { criterion: string }) => value.criterion === '73706b74d24775782c346f427a33f7ea9386e0038f7c50fa7cf317dfa30d1fd1'))
			.toEqual([{ criterion: '73706b74d24775782c346f427a33f7ea9386e0038f7c50fa7cf317dfa30d1fd1', verifierRefs: products }]);
		for (const ref of products) expect(scene.workflow.filter((step: { action: { verifier: string } }) => step.action.verifier === ref)).toHaveLength(1);
		const chatRefs = ['agent.golden.live.campaign', 'agent.golden.architecture-profile-custody-live-1', 'agent.golden.architecture-context-custody-live-1', 'api.golden.execution-normal-sdk-clean-schema-live-1'];
		for (const criterion of ['ce8a386ea8718aa7bf61c8a5a4602520e62bc90d036ff71adf98cb583389973d', '81b30905093d840992af882b011c2432cc199883a09a948a0fe1c8aced8518b7'])
			expect(manifest.acceptanceCriteria.filter((value: { criterion: string }) => value.criterion === criterion)).toEqual([{ criterion, verifierRefs: chatRefs }]);
		for (const ref of chatRefs) expect(scene.workflow.filter((step: { action: { verifier: string } }) => step.action.verifier === ref)).toHaveLength(1);

		expect(manifest.acceptanceCriteria.filter((value: { criterion: string }) => value.criterion === '6d60760e803393ac8b34ab27a04de70ca629758febb90080fdeb1dca9d39b16a')).toEqual([{"criterion":"6d60760e803393ac8b34ab27a04de70ca629758febb90080fdeb1dca9d39b16a","verifierRefs":["agent.golden.live.campaign"]}]);
		expect(manifest.acceptanceCriteria.filter((value: { criterion: string }) => value.criterion === 'a07716b1dea1d92f60e010366f4c9330d7543e1efd8c062af74ebcc3849c572d')).toEqual([{"criterion":"a07716b1dea1d92f60e010366f4c9330d7543e1efd8c062af74ebcc3849c572d","verifierRefs":["agent.golden.execution-clock-observation-live-1","api.golden.execution-protected-observation-live-1","agent.golden.live.settlement","agent.golden.architecture-record-custody-live-1"]}]);
		// Composite requirements reuse the already selected owning assertions.
		for (const binding of [{"criterion":"9ac73476e2d988533827fbfefe5178fc4b83d2b6e6daafe0a14d76816ec643b7","verifierRefs":["sdk.golden.live.product","agent.golden.architecture-living-graph-live-1","api.golden.execution-protected-observation-live-1","api.golden.execution-normal-sdk-clean-schema-live-1"]}, {"criterion":"c284ecb8b5cddbd8ef35e9d0796cae52cb1c750ff85f90e6801da9d5ac373dde","verifierRefs":["agent.golden.live.campaign","agent.golden.execution-clock-observation-live-1","api.golden.execution-protected-observation-live-1","api.golden.execution-normal-sdk-clean-schema-live-1"]}, {"criterion":"ae850ba87f0c47a42f678d27bf772635c3cb02e9bf566bf0619fbcfaf9d049a1","verifierRefs":["agent.golden.live.campaign","agent.golden.architecture-profile-custody-live-1","agent.golden.architecture-context-custody-live-1","agent.golden.architecture-living-graph-live-1","sdk.golden.live.product","api.golden.execution-protected-observation-live-1"]}, {"criterion":"f3bf718737305d7ef5d405762479bdc5f688a20e6e6ee1443c5e8a2ca11dd3a6","verifierRefs":["agent.golden.live.campaign","agent.golden.architecture-profile-custody-live-1","agent.golden.architecture-living-graph-live-1","sdk.golden.live.product"]}, {"criterion":"7d48490c6689efd570c3e337f2320efde901d6469b8618f3f126d6ecdc3eec64","verifierRefs":["agent.golden.live.campaign"]}, {"criterion":"38beb78ee665869dfcd6d42a773f1b6440d4988fd9e5b0d06d3b992d3f297e5c","verifierRefs":["sdk.golden.live.product","agent.golden.architecture-living-graph-live-1","api.golden.execution-protected-observation-live-1","agent.golden.architecture-profile-custody-live-1","agent.golden.architecture-context-custody-live-1","agent.golden.live.campaign"]}, {"criterion":"f2a4ccdf8ff3c85e44b25f5cc4bf1597ef28e63f8217dd52416305c0d6dc345b","verifierRefs":["sdk.golden.live.product","agent.golden.architecture-living-graph-live-1","api.golden.execution-protected-observation-live-1"]}, {"criterion":"98fb608e424d3f9348923a05a9154fc9d18ca5ebb65d00ded5efb5936ce7ccee","verifierRefs":["agent.golden.live.campaign"]}, {"criterion":"d4b37f62b1a5213c66ccfb1130237cf8f7e43e9b8732746afc4fd7a629f75ba2","verifierRefs":["agent.golden.live.campaign","agent.golden.architecture-profile-custody-live-1","agent.golden.architecture-context-custody-live-1","agent.golden.architecture-record-custody-live-1"]}, {"criterion":"878d21214be322d60129356ce3bc779d71a2381e9fc49e05c5442a485da8fcbb","verifierRefs":["agent.golden.live.campaign","agent.golden.architecture-profile-custody-live-1","agent.golden.architecture-context-custody-live-1","agent.golden.architecture-living-graph-live-1","agent.golden.live.results","sdk.golden.live.product","agent.golden.execution-clock-observation-live-1","api.golden.execution-protected-observation-live-1","api.golden.execution-normal-sdk-clean-schema-live-1","agent.golden.architecture-record-custody-live-1"]}, {"criterion":"20c93954e2491ac9d2fb4c9a3632073f5e520ee4dda8fd5e3f114aff1076d750","verifierRefs":["agent.golden.live.campaign","agent.golden.architecture-living-graph-live-1","agent.golden.live.settlement","api.golden.execution-normal-sdk-clean-schema-live-1","agent.golden.architecture-record-custody-live-1"]}, {"criterion":"8e39bb80de13bd6cbad46f12bb890cc41bf1bac8ae8ec749259a0e94ac5faf99","verifierRefs":["agent.golden.live.graph","agent.golden.architecture-graph-history-live-1","agent.golden.architecture-living-graph-live-1","agent.golden.architecture-living-graph-live-2"]}, {"criterion":"b26de9a0e03d3e89af32a7cc48b5f09b23498006423fc89dd62f990944e89d23","verifierRefs":["api.golden.execution-normal-sdk-clean-schema-live-1","agent.golden.architecture-record-custody-live-1","agent.golden.architecture-graph-history-live-1"]}, {"criterion":"3a89aadec8aa532de1eda910051dd97f36f118145cc0922315e20d02a8d7d60b","verifierRefs":["agent.golden.live.campaign","agent.golden.architecture-graph-history-live-1","api.golden.execution-normal-sdk-clean-schema-live-1"]}, {"criterion":"f87dda27c2218e505d7a6723bf09ca896a84095f5b1aa9336c9afa05a920d153","verifierRefs":["sdk.golden.live.product","agent.golden.architecture-living-graph-live-1","api.golden.execution-protected-observation-live-1"]}, {"criterion":"b6e92528f351cfe23f81ba0360fcbaa793a09901a631ea997c1753296a8600c0","verifierRefs":["agent.golden.live.campaign","api.golden.execution-normal-sdk-clean-schema-live-1","agent.golden.architecture-record-custody-live-1"]}, {"criterion":"8a44a09cbcc4fc65a34e37d7fde84c6a188a97316c052e565feec2b0e41c77e7","verifierRefs":["agent.golden.execution-clock-observation-live-1","api.golden.execution-protected-observation-live-1","agent.golden.live.results"]}]) {
			expect(manifest.acceptanceCriteria.filter((value: { criterion: string }) => value.criterion === binding.criterion)).toEqual([binding]);
			for (const ref of binding.verifierRefs) expect(scene.workflow.filter((step: { action: { verifier: string } }) => step.action.verifier === ref)).toHaveLength(1);
		}

	});
	it('binds exact simulation Git workspace custody to live approved bases and independently resolved published branches', () => {
		const manifest = parse(readFileSync(resolve(root, 'guarantees/agent/golden/sdk-complete.guarantee.yaml'), 'utf8'));
		const scene = parse(readFileSync(resolve(root, manifest.scene.manifest), 'utf8'));
		const refs = ['agent.golden.live.campaign', 'agent.golden.architecture-profile-custody-live-1', 'sdk.golden.live.product'];
		expect(manifest.acceptanceCriteria.filter((value: { criterion: string }) =>
			value.criterion === '2bcb03ca47bbe9ffe324405ca36a2464dbe0d613a7777b6973d0b10bd6ea50dd')).toEqual([
			{ criterion: '2bcb03ca47bbe9ffe324405ca36a2464dbe0d613a7777b6973d0b10bd6ea50dd', verifierRefs: refs },
		]);
		expect(manifest.acceptanceCriteria.filter((value: { criterion: string }) => value.criterion ===
			'6d34d659df17e81ab1b96cf86c9fb401b7dcaff4a59a49a41999fe38e65f9bd9')).toEqual([{
			criterion: '6d34d659df17e81ab1b96cf86c9fb401b7dcaff4a59a49a41999fe38e65f9bd9', verifierRefs: refs }]);
		for (const ref of refs) expect(scene.workflow.filter((step: { action: { verifier: string } }) => step.action.verifier === ref)).toHaveLength(1);
	});
	it('binds terminal-status insufficiency to every original normal SDK evidence step without a terminal-only shortcut', () => {
		const manifest = parse(readFileSync(resolve(root, 'guarantees/agent/golden/sdk-complete.guarantee.yaml'), 'utf8'));
		const scene = parse(readFileSync(resolve(root, manifest.scene.manifest), 'utf8'));
		const refs = scene.workflow.map((step: { action: { verifier: string } }) => step.action.verifier);
		expect(refs).toHaveLength(22); expect(new Set(refs).size).toBe(22);
		expect(manifest.acceptanceCriteria.filter((value: { criterion: string }) =>
			value.criterion === 'a571727bb7e1d74fcf9fda7ba50ecd003db8732cd1be6183c2f80ffa85d43691')).toEqual([
			{ criterion: 'a571727bb7e1d74fcf9fda7ba50ecd003db8732cd1be6183c2f80ffa85d43691', verifierRefs: refs },
		]);
	});
	it('binds portfolio normalization to the original prospective campaign freeze without adding a future passing receipt', () => {
		const manifest = parse(readFileSync(resolve(root, 'guarantees/agent/golden/sdk-complete.guarantee.yaml'), 'utf8'));
		expect(manifest.acceptanceCriteria.filter((value: { criterion: string }) => value.criterion === '8ef82a4f4cb2b8e93d060e38cf8758944d2ba54baca44787811a1d76683f99d4'))
			.toEqual([{ criterion: '8ef82a4f4cb2b8e93d060e38cf8758944d2ba54baca44787811a1d76683f99d4', verifierRefs: ['agent.golden.live.campaign-freeze'] }]);
	});
	it('binds default policy and immutable issued overrides to preflight campaign and original native SDK policy custody in order', () => {
		const manifest = parse(readFileSync(resolve(root, 'guarantees/agent/golden/sdk-complete.guarantee.yaml'), 'utf8'));
		const scene = parse(readFileSync(resolve(root, manifest.scene.manifest), 'utf8'));
		const required = ['agent.golden.live.campaign-freeze', 'agent.golden.live.campaign', 'api.golden.execution-normal-sdk-clean-schema-live-1'];
		expect(manifest.acceptanceCriteria.filter((value: { criterion: string }) => value.criterion === '6e48b90ae52851e7b8fd728de8bb32610a60fc7c93dd445a93d3354aa00b652e'))
			.toEqual([{ criterion: '6e48b90ae52851e7b8fd728de8bb32610a60fc7c93dd445a93d3354aa00b652e', verifierRefs: required }]);
		const refs: string[] = scene.workflow.map((step: { action: { verifier: string } }) => step.action.verifier);
		for (const ref of required) expect(refs.filter(value => value === ref)).toHaveLength(1);
		expect(refs.indexOf(required[1]!)).toBeGreaterThan(refs.indexOf(required[0]!));
		expect(refs.indexOf(required[2]!)).toBeGreaterThan(refs.indexOf(required[1]!));
	});
	it('binds sole simulation mode to immediate campaign observation independent native Workday authority and unchanged canonical terminal records', () => {
		const manifest = parse(readFileSync(resolve(root, 'guarantees/agent/golden/sdk-complete.guarantee.yaml'), 'utf8'));
		const scene = parse(readFileSync(resolve(root, manifest.scene.manifest), 'utf8'));
		const refs = scene.workflow.map((step: { action: { verifier: string } }) => step.action.verifier);
		const required = ['agent.golden.live.campaign', 'api.golden.execution-normal-sdk-clean-schema-live-1', 'agent.golden.architecture-record-custody-live-1', 'agent.golden.architecture-living-graph-live-1'];
		for (const criterion of ['64ffc06b0d268ad11fbf692ca201cd75423c0afae2a6be3e2ae7cd2eea7fb17f', '4fec957beaa1692299741d8e2d5730027c2f1012f0ee8a4d17e89fadf3a1a524'])
			expect(manifest.acceptanceCriteria.filter((value: { criterion: string }) => value.criterion === criterion))
				.toEqual([{ criterion, verifierRefs: required }]);
		for (const ref of required) expect(refs.filter((value: string) => value === ref)).toHaveLength(1);
		expect(refs.indexOf(required[1]!)).toBeGreaterThan(refs.indexOf(required[0]!));
		expect(refs.indexOf(required[2]!)).toBeGreaterThan(refs.indexOf(required[0]!));
	});
	it('binds canonical public CLI records to unchanged Workday attempt result settlement and independent native schema assertions', () => {
		const manifest = parse(readFileSync(resolve(root, 'guarantees/agent/golden/sdk-complete.guarantee.yaml'), 'utf8'));
		const scene = parse(readFileSync(resolve(root, manifest.scene.manifest), 'utf8'));
		const required = ['api.golden.execution-normal-sdk-clean-schema-live-1', 'agent.golden.architecture-record-custody-live-1'];
		for (const criterion of ['6c6e922d724fe9bf966e3f11456af2f176224cdff4792c9b7a73ce8047659e55',
			'888a86bc48b9b3e86f8db79534cc7f49b849247800d4601b3dc9228f086bc071',
			'349dabbf1022028ef2b7ec696036113837b636df4f164670f3c616b8a563d469']) {
			expect(manifest.acceptanceCriteria.filter((value: { criterion: string }) => value.criterion === criterion))
				.toEqual([{ criterion, verifierRefs: required }]);
		}
		for (const ref of required) expect(scene.workflow.filter((step: { action: { verifier: string } }) => step.action.verifier === ref)).toHaveLength(1);
	});
	it('binds retired authority denial to selected normal SDK native schema and unchanged canonical record readback without requiring controlled failures', () => {
		const manifest = parse(readFileSync(resolve(root, 'guarantees/agent/golden/sdk-complete.guarantee.yaml'), 'utf8'));
		const scene = parse(readFileSync(resolve(root, manifest.scene.manifest), 'utf8'));
		const refs: string[] = scene.workflow.map((step: { action: { verifier: string } }) => step.action.verifier);
		const required = ['api.golden.execution-normal-sdk-clean-schema-live-1', 'agent.golden.architecture-record-custody-live-1'];
		expect(manifest.acceptanceCriteria.filter((value: { criterion: string }) => value.criterion === '2e5d3dfc2cd33fd0656866a59ce59153137c199b766309decab4f71ecbf4e8d7'))
			.toEqual([{ criterion: '2e5d3dfc2cd33fd0656866a59ce59153137c199b766309decab4f71ecbf4e8d7', verifierRefs: required }]);
		for (const ref of required) { expect(refs.filter(value => value === ref)).toHaveLength(1);
			expect(refs.indexOf(ref)).toBeGreaterThan(refs.indexOf('agent.golden.live.campaign')); }
		expect(refs).not.toContain('api.golden.execution-clean-schema-live-1');
	});
	it('binds exact six-pair graph and Reporter chronology requirements to their existing post-campaign native gates', () => {
		const manifest = parse(readFileSync(resolve(root, 'guarantees/agent/golden/sdk-complete.guarantee.yaml'), 'utf8'));
		const scene = parse(readFileSync(resolve(root, manifest.scene.manifest), 'utf8'));
		const refs: string[] = scene.workflow.map((step: { action: { verifier: string } }) => step.action.verifier);
		for (const [criterion, ref, testName] of [
			['3bf7f808c3baf5cc63fc5e8e8c065bc2cd87dea9e2df9aae4d1924565af6acd8', 'agent.golden.live.reporter', 'Golden runtime reporter evidence satisfies its acceptance boundary'],
		]) {
			expect(manifest.acceptanceCriteria.filter((value: { criterion: string }) => value.criterion === criterion))
				.toEqual([{ criterion, verifierRefs: [ref, 'api.golden.execution-normal-sdk-clean-schema-live-1'] }]);
			expect(registry.verifiers[ref]).toMatchObject({ kind: 'nodeTestCase', testFile: 'tests/acceptance/sdk-runtime-golden.test.ts', testName });
			expect(refs.filter(value => value === ref)).toHaveLength(1);
			expect(refs.indexOf(ref)).toBeGreaterThan(refs.indexOf('agent.golden.live.campaign'));
		}
		const nativeReporter = 'api.golden.execution-normal-sdk-clean-schema-live-1';
		expect(refs.filter(value => value === nativeReporter)).toHaveLength(1);
		expect(refs.indexOf(nativeReporter)).toBeGreaterThan(refs.indexOf('agent.golden.live.reporter'));
		expect(manifest.acceptanceCriteria.filter((value: { criterion: string }) => value.criterion === '81543856c351d2d7f2599a17d9225b1d5d6785c88897775ff79ec4b2af482b65'))
			.toEqual([{ criterion: '81543856c351d2d7f2599a17d9225b1d5d6785c88897775ff79ec4b2af482b65', verifierRefs: ['agent.golden.live.campaign-freeze'] }]);
		const noop = 'agent.golden.architecture-living-graph-live-2';
		expect(manifest.acceptanceCriteria.filter((value: { criterion: string }) => value.criterion === '4ff1e6e55ccb0038c0f79331029c2ad083409c36058b1e3335b1b44a263b2ce0'))
			.toEqual([{ criterion: '4ff1e6e55ccb0038c0f79331029c2ad083409c36058b1e3335b1b44a263b2ce0', verifierRefs: ['agent.golden.live.graph', 'agent.golden.architecture-graph-history-live-1', noop] }]);
		expect(refs.filter(value => value === noop)).toHaveLength(1);
		expect(refs.indexOf(noop)).toBeGreaterThan(refs.indexOf('agent.golden.architecture-graph-history-live-1'));
		expect(registry.verifiers[noop]).toMatchObject({ kind: 'nodeTestCase', testFile: 'tests/acceptance/workday/living-graph.test.ts',
			testName: 'Living graph identical reconciliation and node inspection preserve assignments usage and every public graph record' });
		const product = 'sdk.golden.live.product';
		const profile = 'agent.golden.architecture-profile-custody-live-1';
		for (const criterion of sdkPermissionCriteria) expect(manifest.acceptanceCriteria.filter((value: { criterion: string }) => value.criterion === criterion))
			.toEqual([{ criterion, verifierRefs: [profile, product] }]);
		expect(manifest.acceptanceCriteria.filter((value: { criterion: string }) => value.criterion === 'a6f86094d3c2dc802a54319c3b55c1fb50fa3f1bdc5f9ee831088347c22732bb'))
			.toEqual([{ criterion: 'a6f86094d3c2dc802a54319c3b55c1fb50fa3f1bdc5f9ee831088347c22732bb', verifierRefs: [profile, product] }]);
		expect(refs.filter(value => value === profile)).toHaveLength(1);
		expect(refs.indexOf(profile)).toBeGreaterThan(refs.indexOf('agent.golden.live.campaign'));
		expect(refs.indexOf(profile)).toBeLessThan(refs.indexOf(product));
		expect(registry.verifiers[profile]).toMatchObject({ kind: 'nodeTestCase', testFile: 'tests/acceptance/workday/profile-custody.test.ts',
			testName: 'Every actual assignment matches independently read exact governed profile bytes handler prompt parameters and narrower grants' });
		expect(manifest.acceptanceCriteria.filter((value: { criterion: string }) => value.criterion === '6d6749cd8c2676c6c50c009b55025ec3b951589db602440f63b76ba021159f20'))
			.toEqual([{ criterion: '6d6749cd8c2676c6c50c009b55025ec3b951589db602440f63b76ba021159f20', verifierRefs: ['agent.golden.live.graph', product] }]);
		expect(refs.filter(value => value === 'agent.golden.live.graph')).toHaveLength(1);
		const reviewed = 'agent.golden.architecture-living-graph-live-1';
		expect(manifest.acceptanceCriteria.filter((value: { criterion: string }) => value.criterion === 'dfb95035968dd59b213d812c3023894e30dec856700eaeb985f0556cd53d0088'))
			.toEqual([{ criterion: 'dfb95035968dd59b213d812c3023894e30dec856700eaeb985f0556cd53d0088', verifierRefs: [profile, 'agent.golden.live.graph', reviewed] }]);
		const workspaces = [profile, 'agent.golden.live.settlement', 'agent.golden.architecture-record-custody-live-1'];
		expect(manifest.acceptanceCriteria.filter((value: { criterion: string }) => value.criterion === '1b8f85527f4b286aff075cfe1892180d1407c503fcebab5193560cb915699ea3'))
			.toEqual([{ criterion: '1b8f85527f4b286aff075cfe1892180d1407c503fcebab5193560cb915699ea3', verifierRefs: workspaces }]);
		for (const ref of workspaces) expect(refs.filter(value => value === ref)).toHaveLength(1);
		expect(manifest.acceptanceCriteria.filter((value: { criterion: string }) => value.criterion === '7db60618a6757d8741156428465e37c46211c1a8a5b2125cae87550534778751'))
			.toEqual([{ criterion: '7db60618a6757d8741156428465e37c46211c1a8a5b2125cae87550534778751', verifierRefs: [product, profile, reviewed] }]);
		expect(manifest.acceptanceCriteria.filter((value: { criterion: string }) => value.criterion === '614467b937b7b271b37e1e7b484adba4d65cf486993d9273807130dcc351f69e'))
			.toEqual([{ criterion: '614467b937b7b271b37e1e7b484adba4d65cf486993d9273807130dcc351f69e', verifierRefs: [product, reviewed] }]);
		expect(manifest.acceptanceCriteria.filter((value: { criterion: string }) => value.criterion === '697358e950cb89fc5928569468cd955c25daa8fda7ff97fd1a4af35e2eb95fc6'))
			.toEqual([{ criterion: '697358e950cb89fc5928569468cd955c25daa8fda7ff97fd1a4af35e2eb95fc6', verifierRefs: ['agent.golden.live.graph', reviewed] }]);
		expect(refs.filter(value => value === reviewed)).toHaveLength(1);
		expect(refs.indexOf(reviewed)).toBeGreaterThan(refs.indexOf('agent.golden.live.campaign'));
		expect(refs.indexOf('agent.golden.live.graph')).toBeGreaterThan(refs.indexOf('agent.golden.live.campaign'));
		expect(registry.verifiers['agent.golden.live.graph']).toMatchObject({ kind: 'nodeTestCase', testFile: 'tests/acceptance/sdk-runtime-golden.test.ts',
			testName: 'Golden runtime graph evidence satisfies its acceptance boundary' });
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
		expect(manifest.acceptanceCriteria.filter((value: { criterion: string }) =>
			value.criterion === 'ce87c6c4895321258d1ff9d3f00d7e0db7f1adb6639696756208e784d546667a'))
			.toEqual([{ criterion: 'ce87c6c4895321258d1ff9d3f00d7e0db7f1adb6639696756208e784d546667a',
				verifierRefs: ['agent.golden.live.graph', product] }]);
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
		const scene = parse(readFileSync(resolve(root, manifest.scene.manifest), 'utf8'));
		const refs = scene.workflow.map((step: { action: { verifier: string } }) => step.action.verifier);
		const preRunBindings = [
			'5a286ca84dffc7ea229c2035a106c26aa0f8fe4e78da3cb035b1bc4859810e95',
			'ab2ac9ce3bbbf837b5c65b9b6246aa6850713b4d82fc15c52d590144dd265a0b',
			'9780db98a89476091e8d49891f9fb48d34e70b652c3dfac1e5d112073005860b',
			'd0d88543bffc985ae6a97d06ddc7437472347967b6797d3f797e11a20d2efae4',
			'a91442785b2fb175d026abe733095093fd4fc975f2485d29ad17c7229c237e24',
			'81543856c351d2d7f2599a17d9225b1d5d6785c88897775ff79ec4b2af482b65',
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
		const runtimeHandlers = ['agent.golden.live.campaign-freeze', 'deployment.golden.execution-selected-code-preflight-1'];
		expect(manifest.acceptanceCriteria.filter((value: { criterion: string }) =>
			value.criterion === 'fc80e789a38eb6ae75fada867226ac0157844505619b12c90c55cbe317c6cc9d'))
			.toEqual([{ criterion: 'fc80e789a38eb6ae75fada867226ac0157844505619b12c90c55cbe317c6cc9d', verifierRefs: runtimeHandlers }]);
		expect(manifest.acceptanceCriteria).toEqual([{"criterion":"98fb608e424d3f9348923a05a9154fc9d18ca5ebb65d00ded5efb5936ce7ccee","verifierRefs":["agent.golden.live.campaign"]},{"criterion":"d4b37f62b1a5213c66ccfb1130237cf8f7e43e9b8732746afc4fd7a629f75ba2","verifierRefs":["agent.golden.live.campaign","agent.golden.architecture-profile-custody-live-1","agent.golden.architecture-context-custody-live-1","agent.golden.architecture-record-custody-live-1"]},{"criterion":"6d34d659df17e81ab1b96cf86c9fb401b7dcaff4a59a49a41999fe38e65f9bd9","verifierRefs":["agent.golden.live.campaign","agent.golden.architecture-profile-custody-live-1","sdk.golden.live.product"]},{"criterion":"ee95f7eb3323545534ac708f6ef6ae9d6b9ae2ae40ad4268738084a25d293d86","verifierRefs":["sdk.golden.live.product","agent.golden.architecture-living-graph-live-1"]},{"criterion":"a4199e48998233b28a6aa7480d4a386c32675970f2989ad2719240055fa91443","verifierRefs":["sdk.golden.live.product","api.golden.execution-protected-observation-live-1"]},{"criterion":"6a572f1a5833a039bdc575588d8e6e272a0e71a29a5faaeeeb7b5c85d6544ee6","verifierRefs":["agent.golden.live.campaign-freeze","deployment.golden.execution-selected-code-preflight-1","cli.golden.execution-diagnostics-read-native","agent.golden.live.guest-model-smoke","agent.golden.live.campaign","agent.golden.live.graph","agent.golden.architecture-profile-custody-live-1","agent.golden.architecture-profile-custody-live-2","agent.golden.architecture-context-custody-live-1","agent.golden.architecture-book-knowledge-live-1","agent.golden.architecture-graph-history-live-1","agent.golden.architecture-living-graph-live-1","agent.golden.architecture-living-graph-live-2","sdk.golden.live.product","agent.golden.live.results","agent.golden.execution-clock-observation-live-1","api.golden.execution-protected-observation-live-1","agent.golden.live.reporter","agent.golden.live.settlement","agent.golden.architecture-record-custody-live-1","api.golden.execution-normal-sdk-clean-schema-live-1","agent.golden.execution-normal-sdk-physical-absence-live-1"]},{"criterion":"5ac90e451b0365ff6c44bfbcde86252eb1b53adf6b97972d00a7d5f15b9bf0e9","verifierRefs":["sdk.golden.live.product","agent.golden.architecture-living-graph-live-1","api.golden.execution-protected-observation-live-1"]},{"criterion":"2bcb03ca47bbe9ffe324405ca36a2464dbe0d613a7777b6973d0b10bd6ea50dd","verifierRefs":["agent.golden.live.campaign","agent.golden.architecture-profile-custody-live-1","sdk.golden.live.product"]},{"criterion":"a571727bb7e1d74fcf9fda7ba50ecd003db8732cd1be6183c2f80ffa85d43691","verifierRefs":["agent.golden.live.campaign-freeze","deployment.golden.execution-selected-code-preflight-1","cli.golden.execution-diagnostics-read-native","agent.golden.live.guest-model-smoke","agent.golden.live.campaign","agent.golden.live.graph","agent.golden.architecture-profile-custody-live-1","agent.golden.architecture-profile-custody-live-2","agent.golden.architecture-context-custody-live-1","agent.golden.architecture-book-knowledge-live-1","agent.golden.architecture-graph-history-live-1","agent.golden.architecture-living-graph-live-1","agent.golden.architecture-living-graph-live-2","sdk.golden.live.product","agent.golden.live.results","agent.golden.execution-clock-observation-live-1","api.golden.execution-protected-observation-live-1","agent.golden.live.reporter","agent.golden.live.settlement","agent.golden.architecture-record-custody-live-1","api.golden.execution-normal-sdk-clean-schema-live-1","agent.golden.execution-normal-sdk-physical-absence-live-1"]},{"criterion":"4d3a65d9ab4becd82cc9336051f6e069a26bfcd662eb52fe3f7a32f67c8530bf","verifierRefs":["agent.golden.live.campaign","agent.golden.architecture-profile-custody-live-1","api.golden.execution-normal-sdk-clean-schema-live-1","agent.golden.architecture-record-custody-live-1"]},{"criterion":"9778c4caf01add1b3815fa1cd3fe27ef11073cc98dbdc4a5deeb54e2a441f1dc","verifierRefs":["sdk.golden.live.product"]},{"criterion":"fc80e789a38eb6ae75fada867226ac0157844505619b12c90c55cbe317c6cc9d","verifierRefs":["agent.golden.live.campaign-freeze","deployment.golden.execution-selected-code-preflight-1"]},{"criterion":"1b8f85527f4b286aff075cfe1892180d1407c503fcebab5193560cb915699ea3","verifierRefs":["agent.golden.architecture-profile-custody-live-1","agent.golden.live.settlement","agent.golden.architecture-record-custody-live-1"]},{"criterion":"dfb95035968dd59b213d812c3023894e30dec856700eaeb985f0556cd53d0088","verifierRefs":["agent.golden.architecture-profile-custody-live-1","agent.golden.live.graph","agent.golden.architecture-living-graph-live-1"]},{"criterion":"7db60618a6757d8741156428465e37c46211c1a8a5b2125cae87550534778751","verifierRefs":["sdk.golden.live.product","agent.golden.architecture-profile-custody-live-1","agent.golden.architecture-living-graph-live-1"]},{"criterion":"614467b937b7b271b37e1e7b484adba4d65cf486993d9273807130dcc351f69e","verifierRefs":["sdk.golden.live.product","agent.golden.architecture-living-graph-live-1"]},{"criterion":"8ef82a4f4cb2b8e93d060e38cf8758944d2ba54baca44787811a1d76683f99d4","verifierRefs":["agent.golden.live.campaign-freeze"]},{"criterion":"2feaea9a8a706e1279affead3af5bacc467f12b285ba2570f183361c5d8203c7","verifierRefs":["agent.golden.live.campaign-freeze","agent.golden.live.campaign"]},{"criterion":"64ffc06b0d268ad11fbf692ca201cd75423c0afae2a6be3e2ae7cd2eea7fb17f","verifierRefs":["agent.golden.live.campaign","api.golden.execution-normal-sdk-clean-schema-live-1","agent.golden.architecture-record-custody-live-1","agent.golden.architecture-living-graph-live-1"]},{"criterion":"4fec957beaa1692299741d8e2d5730027c2f1012f0ee8a4d17e89fadf3a1a524","verifierRefs":["agent.golden.live.campaign","api.golden.execution-normal-sdk-clean-schema-live-1","agent.golden.architecture-record-custody-live-1","agent.golden.architecture-living-graph-live-1"]},{"criterion":"6e48b90ae52851e7b8fd728de8bb32610a60fc7c93dd445a93d3354aa00b652e","verifierRefs":["agent.golden.live.campaign-freeze","agent.golden.live.campaign","api.golden.execution-normal-sdk-clean-schema-live-1"]},{"criterion":"6c6e922d724fe9bf966e3f11456af2f176224cdff4792c9b7a73ce8047659e55","verifierRefs":["api.golden.execution-normal-sdk-clean-schema-live-1","agent.golden.architecture-record-custody-live-1"]},{"criterion":"2e5d3dfc2cd33fd0656866a59ce59153137c199b766309decab4f71ecbf4e8d7","verifierRefs":["api.golden.execution-normal-sdk-clean-schema-live-1","agent.golden.architecture-record-custody-live-1"]},{"criterion":"5225ed550726fbcb844fa46c968221c6aa84e694f477dbec024a2c62604e6e5e","verifierRefs":["agent.golden.architecture-profile-custody-live-1","sdk.golden.live.product"]},{"criterion":"bb1e425861ce6c4e6e61ed4f2eeaa39cbcb87cb621edc8e0d10dba4cf82ab681","verifierRefs":["agent.golden.architecture-profile-custody-live-1","sdk.golden.live.product"]},{"criterion":"210c4c11e3c7150e04ba6c29bdab3ad6277418567fb0db8c6b7c342c13cdd897","verifierRefs":["agent.golden.architecture-profile-custody-live-1","sdk.golden.live.product"]},{"criterion":"a213575995fddb824b0b28283bf4cd9532b73b573da57ac3c492aa9aea00bcdc","verifierRefs":["agent.golden.architecture-profile-custody-live-1","sdk.golden.live.product"]},{"criterion":"a6f86094d3c2dc802a54319c3b55c1fb50fa3f1bdc5f9ee831088347c22732bb","verifierRefs":["agent.golden.architecture-profile-custody-live-1","sdk.golden.live.product"]},{"criterion":"e2bf7c70f63b2f4d1532a2d9c62fd7d5b4305151bcadc9c650a3a48bcd8649e7","verifierRefs":["sdk.golden.live.product"]},{"criterion":"47b521b0831f30babf7664f8e12de9b9336a9c949de98473e1767212d7a76cd2","verifierRefs":["sdk.golden.live.product"]},{"criterion":"95e989b76535f28f68527b4e3cf57ca49437695c9f97c57acdfca81d2f62055a","verifierRefs":["sdk.golden.live.product"]},{"criterion":"96a6b0f3ae0587119f592e97fc93efdaae676674a34fb9e9511fd0a9a044fd6e","verifierRefs":["sdk.golden.live.product"]},{"criterion":"11dc8f94be641ad4a78110ac48b1a33144ab46b5a4faac7b3eba1c3873360ec6","verifierRefs":["sdk.golden.live.product"]},{"criterion":"9aa7395c3dc83d555538ad7b6ecfa3d307744044bab0de0574731218ca2e7710","verifierRefs":["sdk.golden.live.product"]},{"criterion":"ae904659a63c9d7478fecc4ba97674ff617e9aee8e0d4e2c3aa96ce1eb16a7cd","verifierRefs":["sdk.golden.live.product"]},{"criterion":"a36158a2e8f122136ece95b41cfd72c345beefa609df5ec27e296b56e77de930","verifierRefs":["sdk.golden.live.product"]},{"criterion":"b635827ed7862d56b8764dfad30114b9ee18d02b4aa709a257841e18a1bd0f0d","verifierRefs":["agent.golden.execution-clock-observation-live-1","api.golden.execution-protected-observation-live-1"]},{"criterion":"7eaf9fdc1c264e2d0b28d2fc751da33a2ffcf98ca0d6446ac6e8672503dfa533","verifierRefs":["agent.golden.live.reporter","agent.golden.live.settlement"]},{"criterion":"5a286ca84dffc7ea229c2035a106c26aa0f8fe4e78da3cb035b1bc4859810e95","verifierRefs":["agent.golden.live.campaign-freeze"]},{"criterion":"ab2ac9ce3bbbf837b5c65b9b6246aa6850713b4d82fc15c52d590144dd265a0b","verifierRefs":["agent.golden.live.campaign-freeze"]},{"criterion":"9780db98a89476091e8d49891f9fb48d34e70b652c3dfac1e5d112073005860b","verifierRefs":["agent.golden.live.campaign-freeze"]},{"criterion":"d0d88543bffc985ae6a97d06ddc7437472347967b6797d3f797e11a20d2efae4","verifierRefs":["agent.golden.live.campaign-freeze"]},{"criterion":"a91442785b2fb175d026abe733095093fd4fc975f2485d29ad17c7229c237e24","verifierRefs":["agent.golden.live.campaign-freeze"]},{"criterion":"81543856c351d2d7f2599a17d9225b1d5d6785c88897775ff79ec4b2af482b65","verifierRefs":["agent.golden.live.campaign-freeze"]},{"criterion":"1dd6f762ce6507847246f790bf57d735bcefe27c21bf8338a179dddbe3d0f930","verifierRefs":["agent.golden.live.campaign-freeze"]},{"criterion":"ee31029693c8c8c0e9e1b8506a341cbb4ddbc15c585cf16de713dc540f68bf55","verifierRefs":["agent.golden.live.campaign-freeze"]},{"criterion":"70a2f58978eb3f6f32b214260bc87ac3ebfe11060c801f179bfc75da2d06e2ef","verifierRefs":["agent.golden.live.campaign-freeze"]},{"criterion":"a36454b4c07f4f736d412c1839e5cc095481697b65a27b757515fabd34172203","verifierRefs":["agent.golden.live.campaign-freeze"]},{"criterion":"c7a791cfb40d560a846fca80c0e59258b7793e0bd57499b43d9f61df3d2e9b41","verifierRefs":["agent.golden.live.campaign-freeze"]},{"criterion":"3b816289341ea3e179c9e4b75392cff59c7fb254580e63c92c87d96b8a5223db","verifierRefs":["agent.golden.live.campaign-freeze"]},{"criterion":"98984bf7e8b6f1b04e3e994888be21daf1d224eb367d95a0849cd5f6dd94f2a5","verifierRefs":["agent.golden.live.campaign-freeze"]},{"criterion":"b53c04085fa78d71c15f32d94f32b925c316f404a67328a466887cd3d9f34c95","verifierRefs":["agent.golden.live.campaign-freeze"]},{"criterion":"b1862b020ba7f70a9154abe27dc0a6466030dc0d6b3f63f34bdd0485e8a3feba","verifierRefs":["agent.golden.live.campaign-freeze"]},{"criterion":"7df1b6212ad765c7c8538b57df69150c60b7ac8fa19242111963da6f90b2c088","verifierRefs":["agent.golden.live.campaign-freeze"]},{"criterion":"673111d5d0ef3029b0b7bc57eccf0515b661cdaf615ffc0206aa3d085a80f1d5","verifierRefs":["agent.golden.live.campaign-freeze"]},{"criterion":"117e7a5900a48c54a4d536d71de49708dacf59fe52aa27a7ff8c67b4d17d5c16","verifierRefs":["agent.golden.live.campaign-freeze"]},{"criterion":"962cf6428dc2cdd1f720d29bbb68abf250cfbbfe128ac4c79d7f5aee7b6e661a","verifierRefs":["agent.golden.live.campaign-freeze"]},{"criterion":"f29da4387b40305b08caaf15b955526cd99c97df4117eec47d40257d48900157","verifierRefs":["agent.golden.live.campaign-freeze"]},{"criterion":"f86cab61d39ea7f46fb9171c3d75a5e547b256cedd6ec5ca6c480ae26822ef26","verifierRefs":["agent.golden.live.campaign-freeze"]},{"criterion":"67be60c1ce8993d62e20243cf53359ceaf58ab1d8866589af00cae11cb12e295","verifierRefs":["agent.golden.live.campaign-freeze"]},{"criterion":"772870fb89c0c04ea930fb424cc66a0a057131849b5ba8b59f9d1f0da8e48567","verifierRefs":["agent.golden.live.campaign-freeze"]},{"criterion":"bff803652752fed25c48491f7eb474367fd2c061801612238e24f29037db2424","verifierRefs":["agent.golden.live.campaign-freeze"]},{"criterion":"7f4f6bb99633197d6e94efa969cf8fa2da8f65e559aeb22da5707a8fb82c4265","verifierRefs":["agent.golden.live.campaign-freeze"]},{"criterion":"b918b519ac545fdd61faab208687ccc64e1f3d03c9a84dfc57a5cfee6190f3f3","verifierRefs":["agent.golden.live.campaign-freeze"]},{"criterion":"80496650a6ed5888fbda21ddcb15047d221874adb709887306dede9e3e93ff55","verifierRefs":["agent.golden.live.results","api.golden.execution-protected-observation-live-1"]},{"criterion":"6d6749cd8c2676c6c50c009b55025ec3b951589db602440f63b76ba021159f20","verifierRefs":["agent.golden.live.graph","sdk.golden.live.product"]},{"criterion":"697358e950cb89fc5928569468cd955c25daa8fda7ff97fd1a4af35e2eb95fc6","verifierRefs":["agent.golden.live.graph","agent.golden.architecture-living-graph-live-1"]},{"criterion":"3bf7f808c3baf5cc63fc5e8e8c065bc2cd87dea9e2df9aae4d1924565af6acd8","verifierRefs":["agent.golden.live.reporter","api.golden.execution-normal-sdk-clean-schema-live-1"]},{"criterion":"9a9b626b666f555139baf8aabcead659ca30e7f88ad8002f73f2b35ddf542ad4","verifierRefs":["sdk.golden.live.product"]},{"criterion":"8fc0d803455b8e437a458732d5b6ba575f885eb35ba387e93e14230dd40d27b7","verifierRefs":["sdk.golden.live.product"]},{"criterion":"936013d37582fbedab56e17601be3581682b72565d8b7fdaedb75f6a3cd2e64f","verifierRefs":["agent.golden.live.campaign","agent.golden.architecture-book-knowledge-live-1"]},{"criterion":"4f295a5342aaf08b1ca056a5aa8bc00df27a07cf116b6721b6179d575c6b76df","verifierRefs":["sdk.golden.live.product"]},{"criterion":"888a86bc48b9b3e86f8db79534cc7f49b849247800d4601b3dc9228f086bc071","verifierRefs":["api.golden.execution-normal-sdk-clean-schema-live-1","agent.golden.architecture-record-custody-live-1"]},{"criterion":"349dabbf1022028ef2b7ec696036113837b636df4f164670f3c616b8a563d469","verifierRefs":["api.golden.execution-normal-sdk-clean-schema-live-1","agent.golden.architecture-record-custody-live-1"]},{"criterion":"22f329d858029233d66c747de963c8ac14c8655b0fe536ee1921ec39101ca1b8","verifierRefs":["api.golden.execution-normal-sdk-clean-schema-live-1","agent.golden.architecture-record-custody-live-1"]},{"criterion":"6e8f096457026f1992cb08a4e36f02a7c5b55b472e7019ff615866256fac85d2","verifierRefs":["agent.golden.live.campaign","sdk.golden.live.product"]},{"criterion":"0cb616106a09f5279323a975d315c59ebefb6e5e0db2ef52e153c0995038158f","verifierRefs":["agent.golden.live.campaign","sdk.golden.live.product"]},{"criterion":"f02eb0d95e0572b52f73700b689cd584d9ae57a880ca5658546c1cae44b535e4","verifierRefs":["agent.golden.live.campaign","sdk.golden.live.product"]},{"criterion":"2b8cb6c3b6c1014b10ea1263a4e5f0aea2a1b93ae71ec69a0abbb410b304fab1","verifierRefs":["agent.golden.live.campaign","sdk.golden.live.product"]},{"criterion":"ce87c6c4895321258d1ff9d3f00d7e0db7f1adb6639696756208e784d546667a","verifierRefs":["agent.golden.live.graph","sdk.golden.live.product"]},{"criterion":"4ff1e6e55ccb0038c0f79331029c2ad083409c36058b1e3335b1b44a263b2ce0","verifierRefs":["agent.golden.live.graph","agent.golden.architecture-graph-history-live-1","agent.golden.architecture-living-graph-live-2"]},{"criterion":"73706b74d24775782c346f427a33f7ea9386e0038f7c50fa7cf317dfa30d1fd1","verifierRefs":["agent.golden.live.results","sdk.golden.live.product","agent.golden.live.reporter","api.golden.execution-normal-sdk-clean-schema-live-1"]},{"criterion":"ce8a386ea8718aa7bf61c8a5a4602520e62bc90d036ff71adf98cb583389973d","verifierRefs":["agent.golden.live.campaign","agent.golden.architecture-profile-custody-live-1","agent.golden.architecture-context-custody-live-1","api.golden.execution-normal-sdk-clean-schema-live-1"]},{"criterion":"81b30905093d840992af882b011c2432cc199883a09a948a0fe1c8aced8518b7","verifierRefs":["agent.golden.live.campaign","agent.golden.architecture-profile-custody-live-1","agent.golden.architecture-context-custody-live-1","api.golden.execution-normal-sdk-clean-schema-live-1"]},{"criterion":"8e39bb80de13bd6cbad46f12bb890cc41bf1bac8ae8ec749259a0e94ac5faf99","verifierRefs":["agent.golden.live.graph","agent.golden.architecture-graph-history-live-1","agent.golden.architecture-living-graph-live-1","agent.golden.architecture-living-graph-live-2"]},{"criterion":"b26de9a0e03d3e89af32a7cc48b5f09b23498006423fc89dd62f990944e89d23","verifierRefs":["api.golden.execution-normal-sdk-clean-schema-live-1","agent.golden.architecture-record-custody-live-1","agent.golden.architecture-graph-history-live-1"]},{"criterion":"3a89aadec8aa532de1eda910051dd97f36f118145cc0922315e20d02a8d7d60b","verifierRefs":["agent.golden.live.campaign","agent.golden.architecture-graph-history-live-1","api.golden.execution-normal-sdk-clean-schema-live-1"]},{"criterion":"f87dda27c2218e505d7a6723bf09ca896a84095f5b1aa9336c9afa05a920d153","verifierRefs":["sdk.golden.live.product","agent.golden.architecture-living-graph-live-1","api.golden.execution-protected-observation-live-1"]},{"criterion":"b6e92528f351cfe23f81ba0360fcbaa793a09901a631ea997c1753296a8600c0","verifierRefs":["agent.golden.live.campaign","api.golden.execution-normal-sdk-clean-schema-live-1","agent.golden.architecture-record-custody-live-1"]},{"criterion":"8a44a09cbcc4fc65a34e37d7fde84c6a188a97316c052e565feec2b0e41c77e7","verifierRefs":["agent.golden.execution-clock-observation-live-1","api.golden.execution-protected-observation-live-1","agent.golden.live.results"]},{"criterion":"6d60760e803393ac8b34ab27a04de70ca629758febb90080fdeb1dca9d39b16a","verifierRefs":["agent.golden.live.campaign"]},{"criterion":"a07716b1dea1d92f60e010366f4c9330d7543e1efd8c062af74ebcc3849c572d","verifierRefs":["agent.golden.execution-clock-observation-live-1","api.golden.execution-protected-observation-live-1","agent.golden.live.settlement","agent.golden.architecture-record-custody-live-1"]},{"criterion":"20c93954e2491ac9d2fb4c9a3632073f5e520ee4dda8fd5e3f114aff1076d750","verifierRefs":["agent.golden.live.campaign","agent.golden.architecture-living-graph-live-1","agent.golden.live.settlement","api.golden.execution-normal-sdk-clean-schema-live-1","agent.golden.architecture-record-custody-live-1"]},{"criterion":"878d21214be322d60129356ce3bc779d71a2381e9fc49e05c5442a485da8fcbb","verifierRefs":["agent.golden.live.campaign","agent.golden.architecture-profile-custody-live-1","agent.golden.architecture-context-custody-live-1","agent.golden.architecture-living-graph-live-1","agent.golden.live.results","sdk.golden.live.product","agent.golden.execution-clock-observation-live-1","api.golden.execution-protected-observation-live-1","api.golden.execution-normal-sdk-clean-schema-live-1","agent.golden.architecture-record-custody-live-1"]},{"criterion":"f2a4ccdf8ff3c85e44b25f5cc4bf1597ef28e63f8217dd52416305c0d6dc345b","verifierRefs":["sdk.golden.live.product","agent.golden.architecture-living-graph-live-1","api.golden.execution-protected-observation-live-1"]},{"criterion":"38beb78ee665869dfcd6d42a773f1b6440d4988fd9e5b0d06d3b992d3f297e5c","verifierRefs":["sdk.golden.live.product","agent.golden.architecture-living-graph-live-1","api.golden.execution-protected-observation-live-1","agent.golden.architecture-profile-custody-live-1","agent.golden.architecture-context-custody-live-1","agent.golden.live.campaign"]},{"criterion":"7d48490c6689efd570c3e337f2320efde901d6469b8618f3f126d6ecdc3eec64","verifierRefs":["agent.golden.live.campaign"]},{"criterion":"f3bf718737305d7ef5d405762479bdc5f688a20e6e6ee1443c5e8a2ca11dd3a6","verifierRefs":["agent.golden.live.campaign","agent.golden.architecture-profile-custody-live-1","agent.golden.architecture-living-graph-live-1","sdk.golden.live.product"]},{"criterion":"c284ecb8b5cddbd8ef35e9d0796cae52cb1c750ff85f90e6801da9d5ac373dde","verifierRefs":["agent.golden.live.campaign","agent.golden.execution-clock-observation-live-1","api.golden.execution-protected-observation-live-1","api.golden.execution-normal-sdk-clean-schema-live-1"]},{"criterion":"ae850ba87f0c47a42f678d27bf772635c3cb02e9bf566bf0619fbcfaf9d049a1","verifierRefs":["agent.golden.live.campaign","agent.golden.architecture-profile-custody-live-1","agent.golden.architecture-context-custody-live-1","agent.golden.architecture-living-graph-live-1","sdk.golden.live.product","api.golden.execution-protected-observation-live-1"]},{"criterion":"9ac73476e2d988533827fbfefe5178fc4b83d2b6e6daafe0a14d76816ec643b7","verifierRefs":["sdk.golden.live.product","agent.golden.architecture-living-graph-live-1","api.golden.execution-protected-observation-live-1","api.golden.execution-normal-sdk-clean-schema-live-1"]},{"criterion":"d00910e63c8f4df319158d8a692499648dc88c7c01699fd6c175696de27fa41f","verifierRefs":["agent.golden.live.campaign"]},{"criterion":"d5b3bcb8ef18cbdc71fb2cad6fd4a5a4d38a4e203f841050918a824f8676e1bd","verifierRefs":["agent.golden.live.campaign","agent.golden.architecture-profile-custody-live-1","agent.golden.architecture-context-custody-live-1","api.golden.execution-normal-sdk-clean-schema-live-1"]},{"criterion":"b06a86bd461d6b85f92908c972808a53bdd76d725af810911018c85577480e54","verifierRefs":["agent.golden.live.campaign","agent.golden.live.campaign-freeze","agent.golden.architecture-profile-custody-live-1","agent.golden.architecture-context-custody-live-1","agent.golden.architecture-record-custody-live-1","api.golden.execution-normal-sdk-clean-schema-live-1"]},{"criterion":"c9023f97264910d1f1dd874dc89bec5402ec3aa39e86de4a3d19226f99471b8e","verifierRefs":["agent.golden.execution-normal-sdk-physical-absence-live-1","agent.golden.architecture-record-custody-live-1","agent.golden.live.settlement","api.golden.execution-normal-sdk-clean-schema-live-1"]},{"criterion":"ca2e5e81f54794d251c8f59e64a7665ed274ae2bb382cedc38016e94096085a2","verifierRefs":["agent.golden.live.campaign","agent.golden.live.campaign-freeze","agent.golden.architecture-profile-custody-live-1","agent.golden.architecture-context-custody-live-1","agent.golden.architecture-record-custody-live-1","api.golden.execution-protected-observation-live-1","api.golden.execution-normal-sdk-clean-schema-live-1"]},{"criterion":"14449c0ba65b7b7bc3915fb2ef87db4361db5b3c1a16eb5e3965b15787e0a633","verifierRefs":["agent.golden.live.campaign","agent.golden.live.campaign-freeze","agent.golden.architecture-profile-custody-live-1","agent.golden.architecture-context-custody-live-1","agent.golden.architecture-record-custody-live-1","api.golden.execution-protected-observation-live-1","api.golden.execution-normal-sdk-clean-schema-live-1"]},{"criterion":"303fe1d790ea82e3eae083f6f477e2434ab44df60c2e7b2c799be1f6af61d27a","verifierRefs":["agent.golden.live.campaign","agent.golden.live.campaign-freeze","agent.golden.architecture-profile-custody-live-1","agent.golden.architecture-context-custody-live-1","agent.golden.architecture-record-custody-live-1","api.golden.execution-protected-observation-live-1","api.golden.execution-normal-sdk-clean-schema-live-1"]},{"criterion":"948b5a226d7cc181a951a4492c9cd8e08d4f2526e2635d0d1c0f0df9c41c94bb","verifierRefs":["agent.golden.live.campaign","agent.golden.live.campaign-freeze","agent.golden.architecture-profile-custody-live-1","agent.golden.architecture-context-custody-live-1","agent.golden.architecture-record-custody-live-1","api.golden.execution-protected-observation-live-1","api.golden.execution-normal-sdk-clean-schema-live-1"]},{"criterion":"fee988264ac2507890e8dd2e1afee3ff23c868917b174c97a532b2b6e6c02764","verifierRefs":["agent.golden.live.campaign","agent.golden.live.campaign-freeze","agent.golden.architecture-profile-custody-live-1","agent.golden.architecture-context-custody-live-1","agent.golden.architecture-record-custody-live-1","api.golden.execution-protected-observation-live-1","api.golden.execution-normal-sdk-clean-schema-live-1"]},{"criterion":"c7bb1b569687ae6865ce03f335cf18c0b089e82561ef105f61ce3a188f3ca15d","verifierRefs":["agent.golden.live.campaign","agent.golden.live.campaign-freeze","agent.golden.architecture-profile-custody-live-1","agent.golden.architecture-context-custody-live-1","agent.golden.architecture-record-custody-live-1","api.golden.execution-protected-observation-live-1","api.golden.execution-normal-sdk-clean-schema-live-1"]},{"criterion":"9e12c2ff2b78f2ad7f30476027cb34e5c34c9285b0d2b0324427c260fddb71bd","verifierRefs":["agent.golden.live.campaign","agent.golden.architecture-graph-history-live-1","agent.golden.architecture-living-graph-live-1","agent.golden.architecture-record-custody-live-1"]},{"criterion":"8cca846b891a94358f5b14d10ce2b347fc68e66d23fb7b9b4f6400495c2e29e4","verifierRefs":["sdk.golden.live.product","agent.golden.live.campaign","agent.golden.architecture-profile-custody-live-1","agent.golden.architecture-context-custody-live-1","agent.golden.architecture-living-graph-live-1","api.golden.execution-protected-observation-live-1"]},{"criterion":"7592ca5bb190bdbb0076c2ece19a0b35f2697f32555557ada2255cfa40afb690","verifierRefs":["sdk.golden.live.product","agent.golden.live.campaign","agent.golden.architecture-profile-custody-live-1","agent.golden.architecture-context-custody-live-1","agent.golden.architecture-living-graph-live-1","api.golden.execution-protected-observation-live-1"]},{"criterion":"3b1b0b3e69460a27e2e322fab6c989a2d9928a6229b3820ac174a557b21f0122","verifierRefs":["agent.golden.live.campaign","agent.golden.live.campaign-freeze","agent.golden.architecture-profile-custody-live-1","agent.golden.architecture-context-custody-live-1","agent.golden.architecture-record-custody-live-1","api.golden.execution-protected-observation-live-1","api.golden.execution-normal-sdk-clean-schema-live-1"]},{"criterion":"4eed8913d17a59d22abba957017b7f7d41a39c9818da05081950ce169b8a52f4","verifierRefs":["agent.golden.live.campaign","agent.golden.architecture-record-custody-live-1","agent.golden.live.settlement","api.golden.execution-normal-sdk-clean-schema-live-1"]}]);
		expect(scene.scope).toBe('local-integrated-runtime');
		for (const ref of runtimeHandlers) expect(refs.filter((value: string) => value === ref)).toHaveLength(1);
		expect(refs.indexOf(runtimeHandlers[1]!)).toBeGreaterThan(refs.indexOf(runtimeHandlers[0]!));
		expect(refs.indexOf(runtimeHandlers[1]!)).toBeLessThan(refs.indexOf('agent.golden.live.guest-model-smoke'));
		expect(refs.indexOf(runtimeHandlers[1]!)).toBeLessThan(refs.indexOf('agent.golden.live.campaign'));
		expect(refs).not.toContain('deployment.golden.execution-selected-code-live-1');
		expect(registry.verifiers[runtimeHandlers[1]!]).toBeUndefined();
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
		const built = steps.findIndex((step: { name?: string }) => step.name === 'Build public Agent exports for native acceptance readback');
		const native = steps.findIndex((step: { name?: string }) => step.name === 'Reproduce whole guest native boundary before complete verification');
		expect(built).toBeGreaterThan(-1); expect(native).toBeGreaterThan(built); expect(native).toBeLessThan(verify);
		expect(steps[built]?.run).toBe('npm run build:dist');

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
