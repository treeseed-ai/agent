import type { DevelopmentSession, DevelopmentCandidate } from '@treeseed/sdk/development';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ execute: vi.fn(), native: vi.fn(), directory: vi.fn(), read: vi.fn(), files: new Map<string,string>(), fault: '',
	operator: { path: '/operator.json', bytes: 'original-operator', repositories: [{ key: 'sdk', gitUrl: 'https://github.com/treeseed-ai/sdk.git' }, { key: 'sdk-library', gitUrl: 'https://github.com/treeseed-ai/sdk-library.git' }] } }));
vi.mock('node:child_process', () => ({ execFileSync: (...args: unknown[]) => state.execute(...args),execFile:(...args:unknown[])=>state.native(...args) }));
vi.mock('node:fs', () => ({ readFileSync: (path: string) => { if(path === state.operator.path) return state.operator.bytes; const value=state.files.get(path);if(value===undefined)throw new Error('missing original file');return value; }, existsSync: vi.fn(), mkdtempSync: state.directory, writeFileSync: vi.fn() }));
vi.mock('../../acceptance/acceptance-cli.ts', () => ({ read: state.read }));
vi.mock('../../acceptance/freeze-integrity.ts', async original => ({ ...await original<typeof import('../../acceptance/freeze-integrity.ts')>(), readPreRunCampaignFreeze: () => state.operator }));
import { acceptanceReceiptDirectory, captureSdkExternalState, verifySdkExternalState } from '../../acceptance/prepare-campaign.ts';
afterEach(()=>vi.unstubAllEnvs());
const expected = ['sdk','sdk-library'].flatMap(repository => ['remote-refs.txt','releases.json','issues.json','pull-requests.json','deployments.json'].map(kind=>repository+'-'+kind)).concat(['sdk-registry.json','development-selections.json']);
const freeze = { receipts: Object.fromEntries(expected.map(name=>['/receipts/'+name,'original-digest'])) };
function selection(): {session: DevelopmentSession; candidates: DevelopmentCandidate[]} {
 return {session:{schemaVersion:'treeseed.development-session/v2',sessionId:'original-session',actor:'controlled-owner',hostId:'original-host',createdAt:'2026-10-14T00:00:00.000Z',status:'active',
  repositories:[{projectId:'original-project',repository:'treeseed-ai/sdk',worktree:'/controlled/worktree',commit:'a'.repeat(40),branch:'staging',dirty:false,dirtyDigest:null,recipeDigest:'sha256:'+'b'.repeat(64)}],
  targets:[{projectId:'original-project',targetId:'original-target',mode:'live',generation:1,health:'ready'}],leases:[],restoredReceiptId:null,blockers:[]},candidates:[]};
}
beforeEach(async () => {
	vi.stubEnv('TREESEED_ACCEPTANCE_PLATFORM_PATH','/platform');vi.stubEnv('TREESEED_ACCEPTANCE_TEAM','treeseed');state.fault='';state.files.clear();state.execute.mockReset();state.read.mockReset().mockReturnValue({sessions:[selection()]});
	state.execute.mockImplementation((command:string,args:string[])=> {
		if(state.fault==='interrupted')throw new Error('original subprocess interrupted');
		if(state.fault==='empty')return '';
		if(state.fault==='malformed')return '{';
		if(state.fault==='changed'&&command==='git')return 'f'.repeat(40)+'\trefs/heads/staging\n';
		if(command==='git')return 'a'.repeat(40)+'\trefs/heads/staging\n';
		if(command==='npm')return JSON.stringify({name:'@treeseed/sdk',versions:['1.0.0'],'dist-tags':{latest:'1.0.0'},maintainers:[{name:'original-owner'}]});
		const endpoint=args.at(-1)!;
		if(state.fault==='pages-good')return JSON.stringify([{id:2,title:'Preserve ][ braces {} and escaped \" quote'}])+'\n'+JSON.stringify([{id:3,title:'Second page'}]);
  if(state.fault==='pages-truncated')return '[{"id":2}]\n[';
  if(state.fault==='pages-trailing')return '[{"id":2}]garbage';
  if(state.fault==='pages-object')return '{"id":2}';
  if(state.fault==='pages-duplicate')return '[{"id":2}]\n[{"id":2}]';
		const records=endpoint.includes('/issues?')?[{id:1,title:'Original Issue'},{id:2,pull_request:{url:'original-pull'}}]
			:endpoint.includes('/deployments?')?[]:[{id:2,title:'Original publication'}];
		if(state.fault==='duplicate')records.push(structuredClone(records[0]!));
		return JSON.stringify(records);
	});
	state.native.mockReset().mockImplementation((command:string,args:string[],_options:unknown,callback:(error:Error|null,stdout:string,stderr:string)=>void)=>{try{callback(null,state.execute(command,args),'');}catch(error){callback(error as Error,'','');}});
	await captureSdkExternalState('/platform',(name,bytes)=>{ const path='/receipts/'+name;state.files.set(path,bytes);freeze.receipts[path]='sha256:'+createHash('sha256').update(bytes).digest('hex'); });state.execute.mockClear();state.read.mockClear();
});
describe('SDK simulation external-state gate (fixtures are not upstream proof)',()=>{
 it('uses at most five concurrent original read commands and waits for every observation without narrowing the inventory',async()=>{
  let active=0,maximum=0;const finished:string[]=[];
  state.native.mockImplementation((command:string,args:string[],_options:unknown,callback:(error:Error|null,stdout:string,stderr:string)=>void)=>{
   active++;maximum=Math.max(maximum,active);setTimeout(()=>{try{const bytes=state.execute(command,args);active--;finished.push(command+':'+args.join(' '));callback(null,bytes,'');}catch(error){active--;callback(error as Error,'','');}},1);
  });
  const captured=vi.fn(),pending=captureSdkExternalState('/platform',captured);expect(pending).toBeInstanceOf(Promise);await pending;
  expect(maximum).toBeGreaterThan(1);expect(maximum).toBeLessThanOrEqual(5);expect(active).toBe(0);expect(finished).toHaveLength(11);
  expect(captured.mock.calls.map(call=>call[0])).toEqual(expected);expect(new Set(captured.mock.calls.map(call=>call[0])).size).toBe(12);
 });


	it('retains receipt storage beside the immutable freeze and captures each external inventory once',async()=>{
		state.directory.mockReturnValue('/acceptance/sdk.freeze.json.receipts-unique');expect(acceptanceReceiptDirectory('/acceptance/sdk.freeze.json')).toBe('/acceptance/sdk.freeze.json.receipts-unique');expect(state.directory).toHaveBeenCalledWith('/acceptance/sdk.freeze.json.receipts-');
		const capture=vi.fn();await captureSdkExternalState('/platform',capture);const names=capture.mock.calls.map(call=>call[0]);
		expect([...names].sort()).toEqual([...expected].sort());expect(new Set(names).size).toBe(12);expect(names).not.toContain('sdk-dist-tags.json');expect(state.execute).toHaveBeenCalledTimes(11);
		for(const[command,args]of state.execute.mock.calls as Array<[string,string[]]>) {
			if(command==='npm')expect(args).toContain('--registry=https://registry.npmjs.org');
			if(command==='gh'){expect(args).toContain('--hostname');expect(args[args.indexOf('--hostname')+1]).toBe('github.com');expect(args).toContain('--method');expect(args[args.indexOf('--method')+1]).toBe('GET');expect(args).toContain('--paginate');expect(args).not.toContain('--slurp');}
			if(command==='git')expect(args).toEqual(['ls-remote','--refs',expect.stringMatching(/^https:\/\/github\.com\/treeseed-ai\/sdk(?:-library)?\.git$/u)]);
		}
		expect(state.read).toHaveBeenCalledExactlyOnceWith(['dev','status','--all'],'treeseed',true);
		const originals=state.operator.repositories;try {
			state.operator.repositories=originals.map(value=>({...value,key:'repository:treeseed/'+value.key}));
			const canonical=vi.fn();await captureSdkExternalState('/platform',canonical);
			expect(canonical.mock.calls.map(call=>call[0]).filter((name:string)=>name.includes('remote-refs'))).toEqual(['repository%3Atreeseed%2Fsdk-remote-refs.txt','repository%3Atreeseed%2Fsdk-library-remote-refs.txt']);
		} finally {state.operator.repositories=originals;}

		expect(JSON.parse(state.files.get('/receipts/sdk-issues.json')!)).toEqual([{id:1,title:'Original Issue'}]);
		expect(JSON.parse(state.files.get('/receipts/sdk-registry.json')!)['dist-tags']).toEqual({latest:'1.0.0'});
  state.fault='pages-good';const streamed=vi.fn();await captureSdkExternalState('/platform',streamed);
  const releases=JSON.parse(streamed.mock.calls.find(call=>call[0]==='sdk-releases.json')![1]);expect(releases.map((item:{id:number})=>item.id)).toEqual([2,3]);expect(releases[0].title).toContain('][ braces {}');
  const deployments=JSON.parse(streamed.mock.calls.find(call=>call[0]==='sdk-deployments.json')![1]);expect(deployments).toHaveLength(2);expect(deployments.every((item:{statuses:unknown[]})=>item.statuses.length===2)).toBe(true);
  expect(state.execute.mock.calls.some(call=>Array.isArray(call[1])&&call[1].at(-1)==='repos/treeseed-ai/sdk/deployments/2/statuses?per_page=100')).toBe(true);
  for(const fault of ['pages-truncated','pages-trailing','pages-object','pages-duplicate']){state.fault=fault;await expect(async()=>captureSdkExternalState('/platform',()=>{}),fault).rejects.toThrow('ACCEPTANCE_EXTERNAL_PAGES');}

	});
	it('reads all three frozen inventories and accepts only unchanged bytes',async()=>{
		// The former three facts remain covered by the complete sole authorities.
		await verifySdkExternalState(freeze);expect(state.execute).toHaveBeenCalledTimes(11);expect(state.read).toHaveBeenCalledOnce();
		for(const name of expected){const path='/receipts/'+name,original=state.files.get(path)!;state.files.set(path,original+'changed');const failed=new Map(state.files);await expect(async()=>verifySdkExternalState(freeze),name).rejects.toThrow('ACCEPTANCE_EXTERNAL_INVENTORY');expect(state.files).toEqual(failed);state.files.set(path,original);}
		for(const fault of ['empty','malformed','duplicate','interrupted']){state.fault=fault;const held=new Map(state.files);await expect(async()=>verifySdkExternalState(freeze),fault).rejects.toThrow();expect(state.files).toEqual(held);}
		state.fault='changed';const original=new Map(state.files);await expect(async()=>verifySdkExternalState(freeze)).rejects.toThrow('ACCEPTANCE_EXTERNAL_CHANGED');expect(state.files).toEqual(original);
		state.fault='';await verifySdkExternalState(freeze);
  for(const change of [(value:ReturnType<typeof selection>)=>{value.session.hostId='foreign-host';},(value:ReturnType<typeof selection>)=>{value.session.repositories[0]!.commit='f'.repeat(40);},(value:ReturnType<typeof selection>)=>{value.session.targets[0]!.generation++;},(value:ReturnType<typeof selection>)=>{value.session.targets[0]!.mode='released';}]){
   const changed=selection();change(changed);const failed=structuredClone(changed);state.read.mockReturnValue({sessions:[changed]});await expect(async()=>verifySdkExternalState(freeze)).rejects.toThrow('ACCEPTANCE_EXTERNAL_CHANGED');expect(changed).toEqual(failed);
  }
  state.read.mockReturnValue({sessions:[selection(),selection()]});await expect(async()=>verifySdkExternalState(freeze)).rejects.toThrow('ACCEPTANCE_EXTERNAL_SELECTIONS');
  state.read.mockReturnValue({sessions:[{...selection(),candidates:undefined}]});await expect(async()=>verifySdkExternalState(freeze)).rejects.toThrow('ACCEPTANCE_EXTERNAL_SELECTIONS');
  const health=selection();health.session.targets[0]!.health='degraded';state.read.mockReturnValue({sessions:[health]});await verifySdkExternalState(freeze);
  state.read.mockReturnValue({sessions:[selection()]});await verifySdkExternalState(freeze);

	});
	it('does not pass empty or duplicate inventory',async()=>{
		const invalid={receipts:Object.fromEntries(Object.keys(freeze.receipts).map(path=>[path,'sha256:'+'0'.repeat(64)]))};
		await expect(async()=>verifySdkExternalState(invalid)).rejects.toThrow('ACCEPTANCE_EXTERNAL_INVENTORY');expect(state.execute).not.toHaveBeenCalled();
		await expect(async()=>verifySdkExternalState({receipts:{}})).rejects.toThrow('ACCEPTANCE_EXTERNAL_INVENTORY');expect(state.execute).not.toHaveBeenCalled();expect(state.read).not.toHaveBeenCalled();
		for(const name of expected){await expect(async()=>verifySdkExternalState({receipts:{...freeze.receipts,['/duplicate/'+name]:'digest'}}),name).rejects.toThrow('ACCEPTANCE_EXTERNAL_INVENTORY');expect(state.execute).not.toHaveBeenCalled();}
		const original=state.operator.repositories;try{state.operator.repositories=[...original,original[0]!];await expect(async()=>captureSdkExternalState('/platform',()=>{})).rejects.toThrow('ACCEPTANCE_EXTERNAL_SCOPE');expect(state.execute).not.toHaveBeenCalled();}finally{state.operator.repositories=original;}
	});
});
