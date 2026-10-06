import {spawnSync} from 'node:child_process';
import {copyFileSync,mkdirSync,mkdtempSync,readFileSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {developmentRuntimeSchema} from '@treeseed/sdk/development';
import {parse} from 'yaml';

export function providerFreezeFixture() {
	const root=mkdtempSync(join(tmpdir(),'agent-freeze-runtime-'));
	const manifest=parse(readFileSync('treeseed.package.yaml','utf8')) as {development:unknown};
	const provider=developmentRuntimeSchema.parse(manifest.development).targets.find(target=>target.id==='provider')!;
	const script='scripts/capacity/providers/freeze-provider-runtime.ts';
	mkdirSync(join(root,'scripts/capacity/providers'),{recursive:true});
	copyFileSync(script,join(root,script));
	symlinkSync(resolve('node_modules'),join(root,'node_modules'));
	writeFileSync(join(root,'package.json'),JSON.stringify({name:'runtime-closure-fixture',version:'1.0.0',type:'module'}));
	mkdirSync(join(root,'dist'));writeFileSync(join(root,'dist/entry.js'),'export {};');
	const shared=join(root,'.treeseed/docker/runtime/shared');
	mkdirSync(join(shared,'node_modules/@treeseed/sdk'),{recursive:true});
	writeFileSync(join(shared,'package.json'),'{}');
	const dependency=join(shared,'node_modules/@treeseed/sdk/index.js');
	writeFileSync(dependency,'export const closure="actual-prepared-dependency";');
	const operation=provider.freeze!.operation;
	const environment={...process.env,TREESEED_DEVELOPMENT_WORKTREE:root,TREESEED_DEVELOPMENT_WORKSPACE_ROOT:root,...operation.environment};
	return {root,shared,dependency,provider,environment,archive:join(root,'treeseed-agent-provider-runtime.tgz'),
		run:(env:NodeJS.ProcessEnv=environment)=>spawnSync(operation.command,operation.args,{cwd:root,env,encoding:'utf8',timeout:10_000}),
		close:()=>rmSync(root,{recursive:true,force:true})};
}
