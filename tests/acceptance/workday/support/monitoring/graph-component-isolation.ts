import assert from 'node:assert/strict';
import {executionNodeSchema,executionEdgeSchema,validateExecutionGraph} from '@treeseed/sdk/agent-capacity';
import type {GraphRevision} from '@treeseed/sdk/agent-capacity';
import {verifyGraphRetention} from '../evidence-pages.ts';
type Row=Record<string,unknown>;
export type CampaignGraphIsolation={baseline:Row;baselineHistory:GraphRevision[];proposalId:string;projectId:string;workdayId:string};

/** Compare actual pre-admission authority, without inventing historical graphs.
 * Independent operational status may advance; unrelated content authority may not. */
export function verifyCampaignGraphIsolation(graph:Row,input:CampaignGraphIsolation):void {
 const label='ACCEPTANCE_GRAPH_COMPONENT: Unrelated content authority changed';
 try {
  for(const value of[input.proposalId,input.projectId,input.workdayId])assert.ok(typeof value==='string'&&value.trim()===value&&value.length>0&&value.length<=200,label);
  const parse=(value:Row)=>{
   assert.ok(value&&typeof value==='object'&&typeof value.teamId==='string'&&value.teamId,label);
   assert.ok(Number.isSafeInteger(value.revision)&&Number(value.revision)>=0,label);
   assert.ok(typeof value.digest==='string'&&(value.revision===0?value.digest==='':/^sha256:[a-f0-9]{64}$/u.test(value.digest)),label);
   assert.ok(Array.isArray(value.nodes)&&Array.isArray(value.edges),label);
   const nodes=executionNodeSchema.array().parse(value.nodes),edges=executionEdgeSchema.array().parse(value.edges);
   assert.deepEqual(nodes,value.nodes,label);assert.deepEqual(edges,value.edges,label);
   assert.ok(validateExecutionGraph(nodes,edges).ok,label);
   for(const node of nodes)assert.equal(node.teamId,value.teamId,label);
   for(const edge of edges)assert.equal(edge.teamId,value.teamId,label);
   return{nodes,edges};
  };
  verifyGraphRetention(input.baseline,input.baselineHistory);
  const before=parse(input.baseline),after=parse(graph);assert.equal(graph.teamId,input.baseline.teamId,label);assert.ok(Number(graph.revision)>=Number(input.baseline.revision),label);
  const ownProposal=(node:typeof before.nodes[number])=>node.projectId===input.projectId&&node.sourceRef.store==='treedx'&&node.sourceRef.model==='proposal'&&node.sourceRef.id===input.proposalId;
  const allowed=new Set(before.nodes.filter(ownProposal).map(node=>node.id));
  let size=-1;while(size!==allowed.size){size=allowed.size;for(const edge of before.edges)if(allowed.has(edge.fromNodeId)||allowed.has(edge.toNodeId)){allowed.add(edge.fromNodeId);allowed.add(edge.toNodeId);}}
  const oldIds=new Set(before.nodes.map(node=>node.id)),current=new Map(after.nodes.map(node=>[node.id,node]));
  const content=(node:typeof before.nodes[number])=>{const {status:_status,nodeRevision:_revision,graphRevisionUpdated:_updated,...authority}=node;return authority;};
  for(const prior of before.nodes)if(!allowed.has(prior.id)){
   const actual=current.get(prior.id);assert.ok(actual,label);assert.deepEqual(content(actual),content(prior),label);
   assert.ok(actual.nodeRevision>=prior.nodeRevision&&actual.graphRevisionUpdated>=prior.graphRevisionUpdated,label);
  }
  for(const node of after.nodes)if(!oldIds.has(node.id)){
   const ownTurn=node.projectId===input.projectId&&node.workdayId===input.workdayId
    &&((node.sourceRef.store==='postgresql'&&node.sourceRef.model==='workday'&&node.sourceRef.id===input.workdayId
     &&['planning','estimating','reviewing','reporting','condition'].includes(node.kind))
     ||(node.kind==='communication'&&node.sourceRef.store==='treedx'&&node.sourceRef.model==='discussion'));
   assert.ok(ownProposal(node)||ownTurn,label);allowed.add(node.id);
  }
  const unrelated=(edges:typeof before.edges)=>edges.filter(edge=>!allowed.has(edge.fromNodeId)||!allowed.has(edge.toNodeId));
  assert.deepEqual(unrelated(after.edges),unrelated(before.edges),label);
 }catch(cause){throw new Error(label,{cause});}
}
