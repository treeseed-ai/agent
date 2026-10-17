import {expect,it} from 'vitest';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {verifyCampaignGraphIsolation} from '../../../../acceptance/workday/support/monitoring/graph-component-isolation.ts';
import type {GraphRevision} from '@treeseed/sdk/agent-capacity';
import {observeLiveGraphRevisions} from '../../../../acceptance/workday/support/monitoring/live-graph-revisions.ts';
import {retainedGraph} from './graph-retention-fixture.ts';

// The original callable accepts an added owning baseline argument; a shorter
// JavaScript implementation ignores it. That missing semantic check is RED.
type Isolation={baseline:Record<string,unknown>;baselineHistory:GraphRevision[];proposalId:string;projectId:string;workdayId:string};
const observe:(...args:[...Parameters<typeof observeLiveGraphRevisions>,Isolation])=>ReturnType<typeof observeLiveGraphRevisions>=observeLiveGraphRevisions;
it('denies a changed unrelated component even when all original nodes edges and canonical revision receipts remain present',async()=>{
 const f=retainedGraph(),baseline=structuredClone(f.graph),held=structuredClone(f),graph=structuredClone(f.graph);
 graph.nodes.find(node=>node.id===f.outside.id)!.condition!.expectedState='foreign-content-authority';
 const snapshots:GraphRevision[]=[];
 await expect(observe(graph.teamId,()=>graph,cursor=>({items:cursor==='0'?f.history:[],nextCursor:cursor==='0'?'1':cursor}),new Map(),revision=>snapshots.push(revision),{
  baseline,baselineHistory:f.history,proposalId:graph.nodes[0]!.sourceRef.id,projectId:graph.nodes[0]!.projectId,workdayId:graph.nodes[0]!.workdayId!,
 })).rejects.toThrow('ACCEPTANCE_GRAPH_COMPONENT');
 expect(snapshots).toEqual([]);expect(f).toEqual(held);expect(baseline).toEqual(held.graph);
});

function isolation(){const f=retainedGraph();return{f,input:{baseline:structuredClone(f.graph),baselineHistory:structuredClone(f.history),proposalId:f.graph.nodes[0]!.sourceRef.id,projectId:f.graph.nodes[0]!.projectId,workdayId:f.graph.nodes[0]!.workdayId!}};}
it('retains unrelated operational progress and permits content changes inside the original connected component without rewriting either graph',()=>{
 const {f,input}=isolation(),graph=structuredClone(f.graph);graph.nodes[0]!.estimate!.maximumSeconds++;
 graph.nodes.find(node=>node.id===f.outside.id)!.status='blocked';const held=structuredClone({input,graph});
 expect(()=>verifyCampaignGraphIsolation(graph,input)).not.toThrow();expect({input,graph}).toEqual(held);
 const connected=structuredClone(input);connected.baseline.edges.push({...connected.baseline.edges[0]!,id:'original-component-link',fromNodeId:f.outside.id});
 connected.baselineHistory[0]!.changes.addedEdges.push('original-component-link');
 const next=structuredClone(connected.baseline);next.nodes.find(node=>node.id===f.outside.id)!.condition!.expectedState='changed-connected-content';
 expect(()=>verifyCampaignGraphIsolation(next,connected)).not.toThrow();
});
it('denies malformed missing duplicated moved and unrelated graph authority while preserving failed original bytes',()=>{
 const {f,input}=isolation();const changes:Array<(graph:typeof f.graph)=>void>=[
  graph=>{graph.nodes.find(node=>node.id===f.outside.id)!.sourceRef.id='foreign-content';},
  graph=>{graph.nodes.find(node=>node.id===f.outside.id)!.ruleRevision++;},
  graph=>{graph.nodes.find(node=>node.id===f.outside.id)!.graphRevisionCreated++;},
  graph=>{graph.nodes=graph.nodes.filter(node=>node.id!==f.outside.id);},
  graph=>{graph.nodes.push(structuredClone(f.outside));},
  graph=>{graph.nodes.push({...structuredClone(f.outside),id:'new-unrelated-node'});},
  graph=>{graph.edges.push({...graph.edges[0]!,id:'unrelated-new-edge',fromNodeId:f.outside.id});},
  graph=>{graph.teamId='foreign-team';},graph=>{graph.revision=-1;},
 ];
 for(const change of changes){const graph=structuredClone(f.graph);change(graph);const held=structuredClone({input,graph});expect(()=>verifyCampaignGraphIsolation(graph,input)).toThrow('ACCEPTANCE_GRAPH_COMPONENT');expect({input,graph}).toEqual(held);}
 for(const value of [undefined,null,'',[],{}])for(const field of ['nodes','edges','teamId','revision','digest']){
  const baseline={...input.baseline,[field]:value},held=structuredClone(baseline);expect(()=>verifyCampaignGraphIsolation(f.graph,{...input,baseline})).toThrow('ACCEPTANCE_GRAPH_COMPONENT');expect(baseline).toEqual(held);
 }
});
it('permits genuine selected workday births but denies a foreign proposal disguised with the same workday identity',()=>{
 const {f,input}=isolation(),graph=structuredClone(f.graph),own={...structuredClone(graph.nodes[1]!),id:'new-workday-condition',workdayId:input.workdayId};
 own.sourceRef={store:'postgresql',model:'workday',id:input.workdayId};graph.nodes.push(own);
 expect(()=>verifyCampaignGraphIsolation(graph,input)).not.toThrow();
 own.sourceRef={...f.outside.sourceRef};expect(()=>verifyCampaignGraphIsolation(graph,input)).toThrow('ACCEPTANCE_GRAPH_COMPONENT');
 const empty={teamId:f.graph.teamId,revision:0,digest:'',nodes:[],edges:[]};
 const first={...structuredClone(f.graph),nodes:f.graph.nodes.filter(node=>node.id!==f.outside.id)};
 expect(()=>verifyCampaignGraphIsolation(first,{...input,baseline:empty,baselineHistory:[]})).not.toThrow();
});
it('captures public graph authority before actual admission and passes that same baseline into the existing normal campaign inspection',()=>{
 const text=readFileSync(new URL('../../../../acceptance/campaign.test.ts',import.meta.url),'utf8'),ast=ts.createSourceFile('campaign.test.ts',text,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
 const calls:ts.CallExpression[]=[];const walk=(node:ts.Node)=>{if(ts.isCallExpression(node))calls.push(node);ts.forEachChild(node,walk);};walk(ast);
 const start=calls.filter(call=>call.expression.getText(ast)==='read'&&call.arguments[0]?.getText(ast).startsWith("['workdays', 'start'"));expect(start).toHaveLength(1);
 const baseline=calls.filter(call=>call.expression.getText(ast)==='structuredClone'&&call.arguments[0]?.getText(ast)==="read(['execution','graph','show'],team)");expect(baseline).toHaveLength(1);expect(baseline[0]!.pos).toBeLessThan(start[0]!.pos);
 const inspect=calls.filter(call=>call.expression.getText(ast)==='observeLiveGraphRevisions');expect(inspect).toHaveLength(1);const scope=inspect[0]!.arguments[5];expect(scope&&ts.isObjectLiteralExpression(scope)).toBe(true);
 expect(scope!.getText(ast)).toBe('{baseline:originalGraph,baselineHistory:originalGraphHistory,proposalId:String(freeze.proposal.id),projectId:String(body.projects[0]),workdayId}');
 // Wiring assertion supplements real SDK/HTTP and native SQL boundaries.
});
