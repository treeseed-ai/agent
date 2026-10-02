import {execFileSync,spawnSync} from 'node:child_process';
import {mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {developmentRuntimeSchema} from '@treeseed/sdk/development';
import {parse} from 'yaml';
import {expect,it} from 'vitest';

it('freezes generated provider dependency bytes through the real declared packaging operation',()=>{
 const manifest=parse(readFileSync('treeseed.package.yaml','utf8')) as {development:unknown};
 const target=developmentRuntimeSchema.parse(manifest.development).targets.find(target=>target.id==='provider')!;
 const freeze=target.freeze!;
 const root=mkdtempSync(join(tmpdir(),'agent-freeze-runtime-'));
 try {
  const pkg=JSON.parse(readFileSync('package.json','utf8')) as {files:string[]};
  writeFileSync(join(root,'package.json'),JSON.stringify({name:'runtime-closure-fixture',version:'1.0.0',files:pkg.files}));
  mkdirSync(join(root,'dist'),{recursive:true});writeFileSync(join(root,'dist/entry.js'),'export {};');
  const shared=join(root,'.treeseed/docker/runtime/shared');
  mkdirSync(join(shared,'node_modules/@treeseed/sdk'),{recursive:true});
  writeFileSync(join(shared,'package.json'),'{}');
  const dependency='export const closure="actual-prepared-dependency";';
  writeFileSync(join(shared,'node_modules/@treeseed/sdk/index.js'),dependency);
  const result=spawnSync(freeze.operation.command,freeze.operation.args,{cwd:root,
   env:{...process.env,...freeze.operation.environment},encoding:'utf8',timeout:10_000});
  expect(result.error).toBeUndefined();expect(result.status,result.stderr).toBe(0);
  const packed=JSON.parse(result.stdout) as Array<{filename:string}>;
  expect(packed).toHaveLength(1);
  const archive=join(root,packed[0]!.filename);
  const entries=execFileSync('tar',['-tzf',archive],{encoding:'utf8',timeout:5000}).trim().split('\n');
  const entry=entries.find(path=>path.endsWith('/node_modules/@treeseed/sdk/index.js'));
  expect(entry,'frozen artifact omitted manager-consumed generated dependency bytes').toBeDefined();
  expect(execFileSync('tar',['-xOf',archive,entry!],{encoding:'utf8',timeout:5000})).toBe(dependency);
 } finally {rmSync(root,{recursive:true,force:true});}
});
