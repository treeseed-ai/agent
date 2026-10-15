import {createServer} from 'node:http';
import {expect,it} from 'vitest';
import {ControlPlaneClient,defaultLocalControlPlaneServer} from '@treeseed/sdk/control-plane-client';
import {controlPlaneOperation} from '@treeseed/sdk/operator-contracts';
import {proposalFeedbackFixture} from './proposal-feedback-fixture.ts';
import {verifyProposalFeedback} from '../../../acceptance/workday/context-custody.test.ts';
import {row} from '../../../acceptance/acceptance-cli.ts';

it('native public SDK proposal reads retain exact resolved feedback and deny blocked omitted late malformed or interrupted observations before unchanged retry',async()=>{
 const f=proposalFeedbackFixture(),requests:string[]=[],failures:unknown[]=[];f.proposal.events=structuredClone(f.blockers);let mode='exact';const original=structuredClone({items:f.items,proposal:f.proposal,files:f.files});
 const server=createServer((request,response)=>{requests.push((request.method??'')+' '+request.url);response.setHeader('content-type','application/json');if(mode==='interrupted'){response.writeHead(503);response.end(JSON.stringify({error:{code:'controlled_interruption',message:'Original controlled native failure'}}));return;}if(mode==='malformed'){response.end('{');return;}const proposal=structuredClone(f.proposal);if(mode==='blocked')row(proposal.readiness).unresolvedBlockerCount=1;if(mode==='omitted')proposal.events=[f.blockers[0]];if(mode==='late')row((proposal.events as unknown[])[1]).createdAt='2026-09-27T00:00:05.000Z';response.end(JSON.stringify({data:proposal}));});
 try{
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});const address=server.address();if(!address||typeof address==='string')throw new Error('Native loopback proposal read required');
  const client=new ControlPlaneClient({profile:defaultLocalControlPlaneServer({TREESEED_API_BASE_URL:'http://127.0.0.1:'+address.port}),accessToken:'controlled-public-fixture'});
  const inspect=async()=>{const observed=row((await client.invoke(controlPlaneOperation('governance.proposals.show'),{path:{projectId:f.attempt.projectId,proposalId:f.source.id},query:{},body:undefined})).data);return verifyProposalFeedback(f.items,'controlled',(args,team,library)=>args[0]==='proposals'?observed:(()=>{const value=structuredClone(f.read(args,team,library));if(mode==='foreign-repository')row(value.result).repoId='foreign';return value;})());};
  expect(await inspect()).toEqual({seen:1,resolved:1});for(mode of ['blocked','omitted','late','malformed','interrupted','foreign-repository']){let error:unknown;try{await inspect();}catch(failure){error=String(failure);}expect(error,mode).toBeDefined();failures.push({mode,error});expect({items:f.items,proposal:f.proposal,files:f.files}).toEqual(original);}
  const retained=structuredClone(failures);mode='exact';expect(await inspect()).toEqual({seen:1,resolved:1});expect(failures).toEqual(retained);expect(requests.every(request=>request==='GET /v1/projects/'+String(f.attempt.projectId)+'/proposals/'+String(f.source.id))).toBe(true);expect({items:f.items,proposal:f.proposal,files:f.files}).toEqual(original);
 }finally{server.closeAllConnections();if(server.listening)await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
 // Native transport/consumer proof with controlled responses. API551 owns native PostgreSQL and TreeDX feedback production; this is not authenticated managed execution.
});
