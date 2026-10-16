import{expect,it}from'vitest';
import{sourceAuthorityFixture}from'./source-authority-fixture.ts';
import{verifySimulationSourceAuthority}from'../../../../acceptance/workday/support/physical/sandbox-inventory.ts';
import{row,type Row}from'../../../../acceptance/acceptance-cli.ts';

it('normal SDK source custody rejects missing foreign credentialed or writable analysis authority across Git read-only and TreeDX assignments without changing unrelated resources',()=>{
 const valid=sourceAuthorityFixture(),before=structuredClone(valid);verifySimulationSourceAuthority(valid.items,valid.status);expect(valid).toEqual(before);
 for(const index of[0,1,2])for(const mode of['missing','owner','provider','attempt','team','project','repository','commit','mode','publication','branch','credential','duplicate','incomplete','confirmation']){
  const f=sourceAuthorityFixture(),workspace=row(f.status.workspace),jobs=row(row(workspace.journals).jobs),entries=jobs.entries as Row[],job=row(entries[index]!.metadata),a=row(job.authority),source=row(a.source);
  if(mode==='missing')delete job.authority;if(mode==='owner')a.assignmentId='foreign';if(mode==='provider')a.providerId='foreign';if(mode==='attempt')a.attempt=2;if(mode==='team')source.teamId='foreign';if(mode==='project')source.projectId='foreign';if(mode==='repository')source.repositoryId='foreign/repository';if(mode==='commit')source.commit='f'.repeat(40);
  if(mode==='mode')a.mode=index===0?'analysis':'work';if(mode==='publication')a.publication='assignment-branch';if(mode==='branch')a.publicationRef='simulation/foreign';if(mode==='credential'){a.acquisition='upstream-authorized';a.credentialBindingId='forbidden-binding';}
  if(mode==='duplicate')entries.push(structuredClone(entries[index]!));if(mode==='incomplete')workspace.complete=false;
  if(mode!=='confirmation')row(workspace.confirmation).journals=structuredClone(workspace.journals);else row(workspace.confirmation).journals={};
  const held=structuredClone(f);expect.soft(()=>verifySimulationSourceAuthority(f.items,f.status),index+'/'+mode).toThrow(/ACCEPTANCE_SOURCE_AUTHORITY/u);expect(f).toEqual(held);
 }
 const retry=sourceAuthorityFixture();verifySimulationSourceAuthority(retry.items,retry.status);expect(retry).toEqual(before);
});
