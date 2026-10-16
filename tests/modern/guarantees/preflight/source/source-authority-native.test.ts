import{expect,it}from'vitest';
import{createServer}from'node:http';
import{mkdtemp,rm}from'node:fs/promises';
import{tmpdir}from'node:os';
import{join}from'node:path';
import{assignmentResultSchema}from'@treeseed/sdk/agent-capacity';
import{portableKernel}from'../../../kernel/architecture/portable/portable-kernel-fixture.ts';
import{SandboxBrokerClient}from'../../../../../src/provider/execution/sandbox-broker-client.ts';
import{verifySimulationSourceAuthority}from'../../../../acceptance/workday/support/physical/sandbox-inventory.ts';
import{row,type Row}from'../../../../acceptance/acceptance-cli.ts';
import{sourceAuthorityFixture}from'./source-authority-fixture.ts';

it('native Kernel Git and original broker status client reject foreign credentialed and interrupted source observations without changing owning candidates or retained failed history',async()=>{
 const kernel=await portableKernel(),directory=await mkdtemp(join(tmpdir(),'agent-source-authority-')),socket=join(directory,'broker.sock'),requests:string[]=[],failures:Row[]=[];let mode='exact';
 const server=createServer((request,response)=>{requests.push(String(request.method)+' '+String(request.url));response.setHeader('content-type','application/json');if(mode==='interrupted'){request.socket.destroy();return;}if(mode==='denied'){response.writeHead(403).end(JSON.stringify({error:'Retained controlled source read denial'}));return;}
  const observed=structuredClone(f.status),workspace=row(observed.workspace),jobs=row(row(workspace.journals).jobs),entries=jobs.entries as Row[],index=mode==='credential-read-only'?1:mode==='credential-treedx'?2:0,job=row(entries[index]!.metadata),a=row(job.authority);
  if(mode==='missing')delete job.authority;if(mode.startsWith('credential-')){a.acquisition='upstream-authorized';a.credentialBindingId='forbidden-binding';}if(mode==='upstream'){a.acquisition='upstream-authorized';a.credentialBindingId='forbidden-binding';a.publication='assignment-branch';}
  if(mode==='foreign-source')row(a.source).commit='f'.repeat(40);if(mode==='duplicate')entries.push(structuredClone(entries[0]!));row(workspace.confirmation).journals=structuredClone(workspace.journals);response.end(JSON.stringify(observed));
 });
 let f:ReturnType<typeof sourceAuthorityFixture>;
 try{
  const candidate=await kernel.candidate(),produced=await kernel.run();expect(produced.status).toBe('completed');const result=assignmentResultSchema.parse(produced.outputs?.assignmentResult);f=sourceAuthorityFixture(kernel.attempt);const held=structuredClone(f);
  await new Promise<void>((accept,reject)=>{server.once('error',reject);server.listen(socket,accept);});const client=new SandboxBrokerClient(socket);
  const inspect=async()=>{let observed:Row|undefined;try{observed=await client.status(AbortSignal.timeout(5_000));const before=structuredClone(observed);try{verifySimulationSourceAuthority(f.items,observed);}finally{expect(observed).toEqual(before);}}
   catch(error){failures.push({mode,error:String(error),...(observed?{observation:observed}:{})});throw error;}finally{expect(f).toEqual(held);expect(kernel.git('rev-parse','HEAD')).toBe(candidate);}};
  await Promise.all([inspect(),inspect()]);for(mode of['missing','credential-read-only','credential-treedx','upstream','foreign-source','duplicate','denied','interrupted'])await expect.soft(inspect(),mode).rejects.toBeInstanceOf(Error);
  const retained=structuredClone(failures);mode='exact';await Promise.all([inspect(),inspect()]);expect(failures).toEqual(retained);expect(failures).toHaveLength(8);expect(assignmentResultSchema.parse(produced.outputs?.assignmentResult)).toEqual(result);expect(requests.every(value=>value==='GET /v1/status')).toBe(true);
  // Actual owning Kernel/Git result and Unix broker-client consumption of
  // controlled status DTOs. Deployment879 separately proves installed public
  // manager/supervisor production. No Kata/model/admission/usage/managed claim.
 }finally{console.log(JSON.stringify({nativeSourceAuthorityFailures:failures}));server.closeAllConnections();if(server.listening)await new Promise<void>((accept,reject)=>server.close(error=>error?reject(error):accept()));await kernel.close();await rm(directory,{recursive:true,force:true});}
 expect(server.listening).toBe(false);
},30_000);
