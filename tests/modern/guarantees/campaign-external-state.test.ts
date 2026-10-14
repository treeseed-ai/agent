import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ execute: vi.fn(), directory: vi.fn(), read: vi.fn(), files: new Map<string,string>(), fault: '',
	operator: { path: '/operator.json', bytes: 'original-operator', repositories: [{ key: 'sdk', gitUrl: 'https://github.com/treeseed-ai/sdk.git' }, { key: 'sdk-library', gitUrl: 'https://github.com/treeseed-ai/sdk-library.git' }] } }));
vi.mock('node:child_process', () => ({ execFileSync: (...args: unknown[]) => state.execute(...args) }));
vi.mock('node:fs', () => ({ readFileSync: (path: string) => { if(path === state.operator.path) return state.operator.bytes; const value=state.files.get(path);if(value===undefined)throw new Error('missing original file');return value; }, existsSync: vi.fn(), mkdtempSync: state.directory, writeFileSync: vi.fn() }));
vi.mock('../../acceptance/acceptance-cli.ts', () => ({ read: state.read }));
vi.mock('../../acceptance/freeze-integrity.ts', async original => ({ ...await original<typeof import('../../acceptance/freeze-integrity.ts')>(), readPreRunCampaignFreeze: () => state.operator }));
import { acceptanceReceiptDirectory, captureSdkExternalState, verifySdkExternalState } from '../../acceptance/prepare-campaign.ts';
afterEach(()=>vi.unstubAllEnvs());
const expected = ['sdk','sdk-library'].flatMap(repository => ['remote-refs.txt','releases.json','issues.json','pull-requests.json','deployments.json'].map(kind=>repository+'-'+kind)).concat(['sdk-registry.json','development-selections.json']);
const freeze = { receipts: Object.fromEntries(expected.map(name=>['/receipts/'+name,'original-digest'])) };
beforeEach(() => {
	vi.stubEnv('TREESEED_ACCEPTANCE_PLATFORM_PATH','/platform');vi.stubEnv('TREESEED_ACCEPTANCE_TEAM','treeseed');state.fault='';state.files.clear();state.execute.mockReset();state.read.mockReset().mockReturnValue({sessions:[]});
	state.execute.mockImplementation((command:string,args:string[])=> {
		if(state.fault==='interrupted')throw new Error('original subprocess interrupted');
		if(state.fault==='empty')return '';
		if(state.fault==='malformed')return '{';
		if(command==='git')return 'a'.repeat(40)+'\trefs/heads/staging\n';
		if(command==='npm')return JSON.stringify({name:'@treeseed/sdk',versions:['1.0.0'],'dist-tags':{latest:'1.0.0'},maintainers:[{name:'original-owner'}]});
		const endpoint=args.at(-1)!;
		const records=endpoint.includes('/issues?')?[{id:1,title:'Original Issue'},{id:2,pull_request:{url:'original-pull'}}]
			:endpoint.includes('/deployments?')?[]:[{id:2,title:'Original publication'}];
		if(state.fault==='duplicate')records.push(structuredClone(records[0]!));
		return JSON.stringify([records]);
	});
	captureSdkExternalState('/platform',(name,bytes)=>state.files.set('/receipts/'+name,bytes));state.execute.mockClear();state.read.mockClear();
});
describe('SDK simulation external-state gate (fixtures are not upstream proof)',()=>{
	it('retains receipt storage beside the immutable freeze and captures each external inventory once',()=>{
		state.directory.mockReturnValue('/acceptance/sdk.freeze.json.receipts-unique');expect(acceptanceReceiptDirectory('/acceptance/sdk.freeze.json')).toBe('/acceptance/sdk.freeze.json.receipts-unique');expect(state.directory).toHaveBeenCalledWith('/acceptance/sdk.freeze.json.receipts-');
		const capture=vi.fn();captureSdkExternalState('/platform',capture);const names=capture.mock.calls.map(call=>call[0]);
		expect([...names].sort()).toEqual([...expected].sort());expect(new Set(names).size).toBe(12);expect(names).not.toContain('sdk-dist-tags.json');expect(state.execute).toHaveBeenCalledTimes(11);
		for(const[command,args]of state.execute.mock.calls as Array<[string,string[]]>) {
			if(command==='npm')expect(args).toContain('--registry=https://registry.npmjs.org');
			if(command==='gh'){expect(args).toContain('--hostname');expect(args[args.indexOf('--hostname')+1]).toBe('github.com');expect(args).toContain('--method');expect(args[args.indexOf('--method')+1]).toBe('GET');expect(args).toContain('--paginate');expect(args).toContain('--slurp');}
			if(command==='git')expect(args).toEqual(['ls-remote','--refs',expect.stringMatching(/^https:\/\/github\.com\/treeseed-ai\/sdk(?:-library)?\.git$/u)]);
		}
		expect(state.read).toHaveBeenCalledExactlyOnceWith(['dev','status','--all'],'treeseed',true);
		expect(JSON.parse(state.files.get('/receipts/sdk-issues.json')!)).toEqual([{id:1,title:'Original Issue'}]);
		expect(JSON.parse(state.files.get('/receipts/sdk-registry.json')!)['dist-tags']).toEqual({latest:'1.0.0'});
	});
	it('reads all three frozen inventories and accepts only unchanged bytes',()=>{
		// The former three facts remain covered by the complete sole authorities.
		verifySdkExternalState(freeze);expect(state.execute).toHaveBeenCalledTimes(11);expect(state.read).toHaveBeenCalledOnce();
		for(const name of expected){const path='/receipts/'+name,original=state.files.get(path)!;state.files.set(path,original+'changed');const failed=new Map(state.files);expect(()=>verifySdkExternalState(freeze),name).toThrow('ACCEPTANCE_EXTERNAL_CHANGED');expect(state.files).toEqual(failed);state.files.set(path,original);}
		for(const fault of ['empty','malformed','duplicate','interrupted']){state.fault=fault;const held=new Map(state.files);expect(()=>verifySdkExternalState(freeze),fault).toThrow();expect(state.files).toEqual(held);}
		state.fault='';verifySdkExternalState(freeze);
	});
	it('does not pass empty or duplicate inventory',()=>{
		const invalid={receipts:Object.fromEntries(Object.keys(freeze.receipts).map(path=>[path,'sha256:'+'0'.repeat(64)]))};
		expect(()=>verifySdkExternalState(invalid)).toThrow('ACCEPTANCE_EXTERNAL_INVENTORY');expect(state.execute).not.toHaveBeenCalled();
		expect(()=>verifySdkExternalState({receipts:{}})).toThrow('ACCEPTANCE_EXTERNAL_INVENTORY');expect(state.execute).not.toHaveBeenCalled();expect(state.read).not.toHaveBeenCalled();
		for(const name of expected){expect(()=>verifySdkExternalState({receipts:{...freeze.receipts,['/duplicate/'+name]:'digest'}}),name).toThrow('ACCEPTANCE_EXTERNAL_INVENTORY');expect(state.execute).not.toHaveBeenCalled();}
		const original=state.operator.repositories;try{state.operator.repositories=[...original,original[0]!];expect(()=>captureSdkExternalState('/platform',()=>{})).toThrow('ACCEPTANCE_EXTERNAL_SCOPE');expect(state.execute).not.toHaveBeenCalled();}finally{state.operator.repositories=original;}
	});
});
