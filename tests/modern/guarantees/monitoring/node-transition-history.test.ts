import {expect,it} from 'vitest';
import * as history from '../../../acceptance/workday/support/campaign-observation.ts';
import {liveAssignmentRecord,liveAssignmentGraph,liveRun} from './live-assignment-fixture.ts';
import {row,type Row} from '../../../acceptance/acceptance-cli.ts';

it('requires complete original node state and revision histories against the current owning graph before progress without rewriting failed observations',()=>{
 const check=Reflect.get(history,'verifyNodeTransitionHistory') as ((run:Row,graph:Row,events:readonly Row[])=>void)|undefined;
 expect(check,'every node transition requires an independent owning inventory comparison').toBeTypeOf('function');if(!check)return;
 const item=liveAssignmentRecord(),run=liveRun(item),graph=liveAssignmentGraph(item),node=(graph.nodes as Row[])[0]!,created=String(item.createdAt);
 const statuses=['proposed','blocked','ready','assigned','running','completed','ready','assigned','running','failed','cancelled','stale'];
 node.status='stale';node.nodeRevision=2;node.graphRevisionUpdated=Number(graph.revision)+statuses.length;graph.revision=node.graphRevisionUpdated;
 const events:Row[]=statuses.map((status,index)=>({id:'node-state-'+index,eventType:'execution.node.state',eventIndex:index,runId:run.id,workdayId:run.id,teamId:run.teamId,projectId:node.projectId,assignmentId:null,status:'recorded',createdAt:new Date(Date.parse(created)+index).toISOString(),context:{nodeId:node.id,nodeRevision:index>=6?2:1,graphRevision:Number(node.graphRevisionCreated)+index+1,status,previousStatus:index?statuses[index-1]:null},parameters:{},metadata:{},refs:{}}));
 const held=structuredClone({run,graph,events});check(run,graph,events);
 for(let index=0;index<events.length;index++){
  const omitted=events.filter((_,offset)=>offset!==index).map((event,eventIndex)=>({...structuredClone(event),eventIndex})),before=structuredClone(omitted);
  expect(()=>check(run,graph,omitted),'missing '+statuses[index]).toThrow('ACCEPTANCE_NODE_TRANSITIONS');expect(omitted).toEqual(before);
 }
 for(const mode of ['wrong-team','wrong-run','wrong-workday','wrong-project','wrong-node','wrong-revision','missing-revision','future-graph','old-graph','wrong-status','wrong-prior','wrong-clock','before-birth','duplicate','wrong-assignment','wrong-record-status']){
  const changed=structuredClone(events),event=changed[4]!,context=row(event.context);
  if(mode==='wrong-team')event.teamId='foreign';if(mode==='wrong-run')event.runId='foreign';if(mode==='wrong-workday')event.workdayId='foreign';if(mode==='wrong-project')event.projectId='foreign';if(mode==='wrong-node')context.nodeId='foreign';
  if(mode==='wrong-revision')context.nodeRevision=3;if(mode==='missing-revision')delete context.nodeRevision;if(mode==='future-graph')context.graphRevision=Number(graph.revision)+1;if(mode==='old-graph')context.graphRevision=0;
  if(mode==='wrong-status')context.status='invented';if(mode==='wrong-prior')context.previousStatus='completed';if(mode==='wrong-clock')event.createdAt='invalid';if(mode==='before-birth')event.createdAt=new Date(Date.parse(created)-1).toISOString();
  if(mode==='duplicate')changed.push({...structuredClone(event),eventIndex:changed.length});if(mode==='wrong-assignment')event.assignmentId=item.id;if(mode==='wrong-record-status')event.status='failed';
  const before=structuredClone(changed);expect(()=>check(run,graph,changed),mode).toThrow('ACCEPTANCE_NODE_TRANSITIONS');expect(changed).toEqual(before);
 }
 for(const mode of ['missing-node','duplicate-node','wrong-terminal','wrong-revision','wrong-graph','foreign-scope']){
  const changed=structuredClone(graph),nodes=changed.nodes as Row[];
  if(mode==='missing-node')nodes.shift();if(mode==='duplicate-node')nodes.push(structuredClone(nodes[0]!));if(mode==='wrong-terminal')nodes[0]!.status='ready';if(mode==='wrong-revision')nodes[0]!.nodeRevision=3;if(mode==='wrong-graph')nodes[0]!.graphRevisionUpdated=Number(graph.revision)-1;if(mode==='foreign-scope')nodes[0]!.workdayId='foreign';
  const before=structuredClone(changed);expect(()=>check(run,changed,events),mode).toThrow('ACCEPTANCE_NODE_TRANSITIONS');expect(changed).toEqual(before);
 }
 const global=structuredClone(graph),globalNode=(global.nodes as Row[])[0]!;delete globalNode.workdayId;
 const globalHistory=structuredClone(events).slice(3);globalHistory.forEach((event,eventIndex)=>{event.eventIndex=eventIndex;});check(run,global,globalHistory);
 const unchanged=structuredClone(graph);(unchanged.nodes as Row[]).push({...structuredClone(node),id:'retained-other-workday',workdayId:'retained-run'});check(run,unchanged,events);
 check(run,{...graph,nodes:[],revision:0},[]);expect({run,graph,events}).toEqual(held);check(run,graph,events);
});
