import {execFileSync} from 'node:child_process';
import {chmodSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,rmSync,statSync,symlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {agentDevelopmentRuntimeRoots,copyDevelopmentRuntime} from '@treeseed/deployment';
import {expect,it} from 'vitest';
import {freezeProviderRuntime} from '../../../../scripts/capacity/providers/freeze-provider-runtime.ts';
import {providerFreezeFixture} from './provider-freeze-fixture.ts';

it('freezes generated provider dependency bytes through the real declared packaging operation',()=>{
 const fixture=providerFreezeFixture(),{root}=fixture;
 try {
  const dependency='export const closure="actual-prepared-dependency";';
  writeFileSync(fixture.dependency,dependency);
  const result=fixture.run();
  expect(result.error).toBeUndefined();expect(result.status,result.stderr).toBe(0);
  const packed=JSON.parse(result.stdout) as Array<{filename:string}>;
  expect(packed).toHaveLength(1);
  const archive=join(root,packed[0]!.filename);
  const entries=execFileSync('tar',['-tzf',archive],{encoding:'utf8',timeout:5000}).trim().split('\n');
  const entry=entries.find(path=>path.endsWith('/node_modules/@treeseed/sdk/index.js'));
  expect(entry,'frozen artifact omitted manager-consumed generated dependency bytes').toBeDefined();
  expect(execFileSync('tar',['-xOf',archive,entry!],{encoding:'utf8',timeout:5000})).toBe(dependency);
 } finally {fixture.close();}
});

it('rejects another worktree before creating or replacing an archive',()=>{
 const fixture=providerFreezeFixture();
 try {expect(()=>freezeProviderRuntime(fixture.root,fixture.root)).toThrow('exact operation worktree');
  expect(readdirSync(fixture.root).filter(path=>path.endsWith('.tgz'))).toEqual([]);
 } finally {fixture.close();}
});

it('rejects missing saved workspace or worktree authority through the native operation',()=>{
 const fixture=providerFreezeFixture();
 try {for(const key of ['TREESEED_DEVELOPMENT_WORKSPACE_ROOT','TREESEED_DEVELOPMENT_WORKTREE']) {
  const env:NodeJS.ProcessEnv={...fixture.environment};delete env[key];
  const result=fixture.run(env);expect(result.error).toBeUndefined();expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('saved development workspace and worktree authority');
  expect(readdirSync(fixture.root).filter(path=>path.endsWith('.tgz'))).toEqual([]);
 }} finally {fixture.close();}
});

it('archives the owning copy aliases hidden filtering and normalized modes with exact readback',()=>{
 const fixture=providerFreezeFixture(),copies=mkdtempSync(join(tmpdir(),'agent-freeze-copies-')),
  readbacks=mkdtempSync(join(tmpdir(),'agent-freeze-readbacks-'));
 try {
  const modules=join(fixture.shared,'node_modules');
  symlinkSync('@treeseed/sdk',join(modules,'alias'));
  mkdirSync(join(modules,'.bin'));writeFileSync(join(modules,'.bin/tool'),'#!/bin/sh\nexit 0\n',{mode:0o777});
  writeFileSync(join(modules,'.env'),'never-archive');chmodSync(fixture.dependency,0o666);
  const copied=copyDevelopmentRuntime({worktree:fixture.root,workspace:fixture.root,destination:join(copies,'copy'),
   sourceUid:process.getuid!(),roots:agentDevelopmentRuntimeRoots});
  const result=fixture.run();expect(result.error).toBeUndefined();expect(result.status,result.stderr).toBe(0);
  execFileSync('tar',['-xzf',fixture.archive,'-C',copies]);
  expect(readFileSync(join(copies,'runtime/node_modules/alias/index.js'))).toEqual(readFileSync(fixture.dependency));
  expect(execFileSync('tar',['-tzf',fixture.archive],{encoding:'utf8'})).not.toContain('.env');
  expect(statSync(join(copies,'runtime/node_modules/.bin/tool')).mode&0o777).toBe(0o755);
  expect(statSync(join(copies,'runtime/node_modules/@treeseed/sdk/index.js')).mode&0o777).toBe(0o644);
  // Inspect the extracted artifact with the same copy authority; no second byte/digest policy.
  const readback=copyDevelopmentRuntime({worktree:join(copies,'runtime'),workspace:copies,destination:join(readbacks,'runtime'),
   sourceUid:process.getuid!(),roots:agentDevelopmentRuntimeRoots.map(root=>({source:root.target,target:root.target}))});
  expect(readback).toEqual(copied);
 } finally {
  rmSync(readbacks,{recursive:true,force:true});
  fixture.close();rmSync(copies,{recursive:true,force:true});
 }
});

it('retains the previous archive and removes private temporary bytes when the native archiver fails',()=>{
 const fixture=providerFreezeFixture(),tools=mkdtempSync(join(tmpdir(),'agent-freeze-tools-'));
 try {
  expect(fixture.run().status).toBe(0);const prior=readFileSync(fixture.archive),source=readFileSync(fixture.dependency);
  symlinkSync(process.execPath,join(tools,'node'));
  const result=fixture.run({...fixture.environment,PATH:tools,TMPDIR:tools,TSX_DISABLE_CACHE:'1'});
  expect(result.error).toBeUndefined();expect(result.status).not.toBe(0);expect(result.stderr).toContain('spawnSync tar ENOENT');
  expect(readFileSync(fixture.archive)).toEqual(prior);expect(readFileSync(fixture.dependency)).toEqual(source);
  expect(readdirSync(tools)).toEqual(['node']);
  expect(readdirSync(fixture.root).filter(path=>path.endsWith('.new'))).toEqual([]);
 } finally {fixture.close();rmSync(tools,{recursive:true,force:true});}
});

it('repeats identical native freezes but binds changed generated dependency bytes',()=>{
 const fixture=providerFreezeFixture();
 try {
  expect(fixture.run().status).toBe(0);const first=readFileSync(fixture.archive);
  expect(fixture.run().status).toBe(0);expect(readFileSync(fixture.archive)).toEqual(first);
  writeFileSync(fixture.dependency,'export const closure="changed";');
  expect(fixture.run().status).toBe(0);expect(readFileSync(fixture.archive)).not.toEqual(first);
  expect(readdirSync(fixture.root).filter(path=>path.endsWith('.new'))).toEqual([]);
 } finally {fixture.close();}
});

it('retains the previous archive and source bytes when materialization rejects an external alias',()=>{
 const fixture=providerFreezeFixture(),outside=mkdtempSync(join(tmpdir(),'agent-freeze-external-'));
 try {
  expect(fixture.run().status).toBe(0);const prior=readFileSync(fixture.archive);
  writeFileSync(join(outside,'entry'),'operator-byte');symlinkSync(outside,join(fixture.shared,'node_modules/external'));
  const result=fixture.run();expect(result.error).toBeUndefined();expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('escaped operator-owned workspace custody');
  expect(readFileSync(fixture.archive)).toEqual(prior);expect(readFileSync(join(outside,'entry'),'utf8')).toBe('operator-byte');
  expect(readdirSync(fixture.root).filter(path=>path.endsWith('.new'))).toEqual([]);
 } finally {fixture.close();rmSync(outside,{recursive:true,force:true});}
});
