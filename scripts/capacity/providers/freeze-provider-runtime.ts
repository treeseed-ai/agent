import {execFileSync} from 'node:child_process';
import {copyFileSync,mkdtempSync,realpathSync,renameSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {agentDevelopmentRuntimeRoots,copyDevelopmentRuntime} from '@treeseed/deployment';

/** Archive the same materialized bytes/aliases/modes as the manager, not raw dependencies. */
export function freezeProviderRuntime(worktree:string,workspace:string) {
	if(realpathSync(worktree)!==realpathSync(process.cwd()))throw new Error('Provider freeze requires the exact operation worktree.');
	const temporary=mkdtempSync(resolve(tmpdir(),'treeseed-provider-freeze-'));
	const filename='treeseed-agent-provider-runtime.tgz';
	const pending=resolve(worktree,`${filename}.${temporary.split('/').at(-1)}.new`);
	try {
		copyDevelopmentRuntime({worktree,workspace,destination:resolve(temporary,'runtime'),sourceUid:process.getuid!(),roots:agentDevelopmentRuntimeRoots});
		const archive=resolve(temporary,filename);
		execFileSync('tar',['--sort=name','--mtime=@0','--owner=0','--group=0','--numeric-owner','-czf',archive,'-C',temporary,'runtime'],{stdio:'pipe'});
		copyFileSync(archive,pending);
		renameSync(pending,resolve(worktree,filename));
		return [{filename}];
	} finally {
		rmSync(pending,{force:true});
		rmSync(temporary,{recursive:true,force:true});
	}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
	const worktree=process.env.TREESEED_DEVELOPMENT_WORKTREE,workspace=process.env.TREESEED_DEVELOPMENT_WORKSPACE_ROOT;
	if(!worktree||!workspace)throw new Error('Provider freeze requires saved development workspace and worktree authority.');
	console.log(JSON.stringify(freezeProviderRuntime(worktree,workspace)));
}
