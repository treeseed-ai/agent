import {execFileSync} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {developmentCandidateSchema,developmentRuntimeSchema} from '@treeseed/sdk/development';
import {agentDevelopmentRuntimeRoots,copyDevelopmentRuntime} from '@treeseed/deployment';
import {parse,stringify} from 'yaml';
import {expect,it} from 'vitest';
import {providerFreezeFixture} from './provider-freeze-fixture.ts';

it('binds generated dependency changes through public CLI freeze and the owning private copy',async()=>{
	// Actual compiled public command boundary; transport only captures fixture registration.
	// Missing checked CLI input fails this complete suite, never skips or substitutes a mock.
	const {runDevelopment}=await import(import.meta.resolve('@treeseed/cli/dist/cli/commands/development.js'));
	const {parseInvocation}=await import(import.meta.resolve('@treeseed/cli/dist/cli/parser.js'));
	const {resolveCommand}=await import(import.meta.resolve('@treeseed/cli/dist/cli/registry.js'));
	const fixture=providerFreezeFixture(),state=mkdtempSync(join(tmpdir(),'agent-freeze-state-')),
		copies=mkdtempSync(join(tmpdir(),'agent-freeze-composition-'));
	const registrations:unknown[]=[];let record:unknown;
	const context={cwd:fixture.root,env:{...process.env,XDG_STATE_HOME:state},interactiveUi:false,outputFormat:'json',write:()=>{},
		hostInvoke:async(input:{handlerId:string;options:Record<string,unknown>})=>{
			const payload=JSON.parse(String(input.options.payload)) as {session:unknown;runtimes:unknown;candidate:unknown};
			if(input.handlerId==='local.dev.session.start'){record={session:payload.session,runtimes:payload.runtimes};return record;}
			if(input.handlerId==='local.dev.status')return record;
			if(input.handlerId==='local.dev.candidate.register'){registrations.push(payload.candidate);return record;}
			throw new Error(`Unexpected transport ${input.handlerId}`);
		}};
	const invoke=async(args:string[])=>{
		const selected=resolveCommand(args);expect(selected).toBeTruthy();
		return runDevelopment(parseInvocation(selected.command,[...selected.rest,'--json']),context) as Promise<unknown>;
	};
	try {
		const document=parse(readFileSync('treeseed.package.yaml','utf8')) as {development:unknown};
		const runtime=developmentRuntimeSchema.parse(document.development);
		// Only this target's archive/copy contract is exercised, not the whole live runtime graph.
		runtime.targets=[{...fixture.provider,dependencies:[]}];
		const manifest=join(fixture.root,'treeseed.package.yaml');writeFileSync(manifest,stringify({development:runtime}));
		writeFileSync(join(fixture.root,'.gitignore'),'node_modules/\ndist/\n.treeseed/\n*.tgz\n');
		const git=(...args:string[])=>execFileSync('git',['-C',fixture.root,...args],{encoding:'utf8'});
		git('init','-b','staging');git('add','.');git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','exact native freeze inputs');
		await invoke(['dev','session','start',manifest]);
		const copy=(name:string)=>copyDevelopmentRuntime({worktree:fixture.root,workspace:fixture.root,
			destination:join(copies,name),sourceUid:process.getuid!(),roots:agentDevelopmentRuntimeRoots});
		const freeze=async()=>{
			const result=await invoke(['dev','freeze']) as {receipt:string};
			return developmentCandidateSchema.parse(JSON.parse(readFileSync(result.receipt,'utf8')));
		};
		const before=copy('before'),first=await freeze();
		writeFileSync(fixture.dependency,'export const closure="different-prepared-dependency";');
		const after=copy('after'),second=await freeze();
		expect(after.digest).not.toBe(before.digest);
		expect(readFileSync(join(copies,'before/node_modules/@treeseed/sdk/index.js'),'utf8')).toBe('export const closure="actual-prepared-dependency";');
		expect(readFileSync(join(copies,'after/node_modules/@treeseed/sdk/index.js'),'utf8')).toBe('export const closure="different-prepared-dependency";');
		expect(registrations).toHaveLength(2);expect(first.source).toEqual(second.source);
		expect(first.artifacts).not.toEqual(second.artifacts);
		expect(first.verification.status).toBe('pending');expect(second.verification.status).toBe('pending');
		expect(first.promotable).toBe(false);expect(second.promotable).toBe(false);
	} finally {fixture.close();rmSync(state,{recursive:true,force:true});rmSync(copies,{recursive:true,force:true});}
});
