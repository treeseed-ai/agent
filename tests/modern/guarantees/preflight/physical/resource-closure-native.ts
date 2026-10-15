import {createServer} from 'node:http';
import {expect} from 'vitest';
import {ControlPlaneClient,defaultLocalControlPlaneServer} from '@treeseed/sdk/control-plane-client';
import {controlPlaneOperation} from '@treeseed/sdk/operator-contracts';
import {encodeCapacityPageCursor} from '@treeseed/sdk/capacity-pagination';
import {row,type Row} from '../../../../acceptance/acceptance-cli.ts';
import {collectCompleteEvidence} from '../../../../acceptance/workday/support/evidence-pages.ts';
import {verifyPublicWorkspaceSessionClosure} from '../../../../acceptance/workday/support/physical/sandbox-inventory.ts';
import {publicResourceClosureFixture} from './resource-closure-fixture.ts';

/** Native public SDK/HTTP consumption of controlled owning responses; native API and TreeDX producers are verified separately. */
export async function provePublicResourceClosureTransport(){
 const f=publicResourceClosureFixture(),before=structuredClone(f.exact),requests:Array<{method:string;url:string}>=[],failures:unknown[]=[];let mode='exact';
 const sessions=[...f.exact.sessions].sort((a,b)=>String(b.id).localeCompare(String(a.id))),cursor=encodeCapacityPageCursor({id:String(sessions[0]!.id),createdAt:String(sessions[0]!.openedAt)});
 const server=createServer((incoming,outgoing)=>{const url=incoming.url??'';requests.push({method:incoming.method??'',url});outgoing.setHeader('content-type','application/json');
  if(url.startsWith('/v1/teams/'+f.attempt.teamId+'/capacity/availability-sessions')){
   const query=new URL(url,'http://127.0.0.1').searchParams,second=query.has('cursor');let items=second?[sessions[1]!]:[sessions[0]!];
   if(second&&mode==='foreign-session')items=[{...items[0]!,providerId:'foreign'}];if(second&&mode==='omitted-session')items=[];
   outgoing.end(JSON.stringify({data:{items,page:{limit:1,hasMore:!second,nextCursor:second?null:mode==='wrong-cursor'?encodeCapacityPageCursor({id:'foreign',createdAt:String(sessions[0]!.openedAt)}):cursor}}}));return;
  }
  if(url==='/v1/dx/projects/library-project/workspaces/ws_owned'){
   if(mode==='interrupted-workspace'){outgoing.writeHead(503);outgoing.end(JSON.stringify({error:{code:'controlled_resource_interruption',message:'Retained controlled native interruption'}}));return;}
   const response=structuredClone(f.exact.response);if(mode==='open-workspace')row(response.result).status='open';if(mode==='foreign-workspace')row(response.result).workspaceId='ws_foreign';
   outgoing.end(JSON.stringify({data:response}));return;
  }
  outgoing.writeHead(404);outgoing.end(JSON.stringify({error:{code:'not_found',message:'Unexpected native read route'}}));
 });
 try{
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});const address=server.address();if(!address||typeof address==='string')throw new Error('Native resource server required');
  const client=new ControlPlaneClient({profile:defaultLocalControlPlaneServer({TREESEED_API_BASE_URL:'http://127.0.0.1:'+address.port}),accessToken:'controlled-resource-fixture'});
  const readSessions=async()=>{const input={path:{teamId:f.attempt.teamId},query:{limit:1},body:undefined};const first=row((await client.invoke(controlPlaneOperation('capacity.status'),input)).data),next=row(first.page).nextCursor;
   const second=row((await client.invoke(controlPlaneOperation('capacity.status'),{...input,query:{limit:1,cursor:next}})).data),pages=[first,second];let index=0;
   return collectCompleteEvidence(requested=>{expect(requested).toBe(index===0?undefined:next);return pages[index++]!;},1,'ACCEPTANCE_RESOURCE_CLOSURE','descending','openedAt');};
  const inspect=async()=>verifyPublicWorkspaceSessionClosure(f.exact.items,await readSessions(),async(projectId,workspaceId)=>row((await client.invoke(controlPlaneOperation('treedx.workspaces.show'),{path:{projectId,workspaceId},query:{},body:undefined})).data));
  await inspect();for(mode of['foreign-session','omitted-session','wrong-cursor','interrupted-workspace','open-workspace','foreign-workspace']){let error:unknown;try{await inspect();}catch(failure){error=String(failure);}expect(error,mode).toBeDefined();failures.push({mode,error,observations:structuredClone(f.exact)});expect(f.exact).toEqual(before);}
  const retained=structuredClone(failures);mode='exact';await inspect();expect(failures).toEqual(retained);expect(f.exact).toEqual(before);expect(requests.every(value=>value.method==='GET')).toBe(true);expect(requests.some(value=>value.url==='/v1/dx/projects/library-project/workspaces/ws_owned')).toBe(true);
 }finally{server.closeAllConnections();if(server.listening)await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
}
