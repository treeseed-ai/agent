import {expect,it} from 'vitest';
import type {GraphRevision} from '@treeseed/sdk/agent-capacity';
import {observeLiveGraphRevisions} from '../../../../acceptance/workday/support/monitoring/live-graph-revisions.ts';
import {retainedGraph} from './graph-retention-fixture.ts';

// The original callable accepts an added owning baseline argument; a shorter
// JavaScript implementation ignores it. That missing semantic check is RED.
type Isolation={baseline:Record<string,unknown>;proposalId:string;projectId:string;workdayId:string};
const observe:(...args:[...Parameters<typeof observeLiveGraphRevisions>,Isolation])=>ReturnType<typeof observeLiveGraphRevisions>=observeLiveGraphRevisions;
it('denies a changed unrelated component even when all original nodes edges and canonical revision receipts remain present',async()=>{
 const f=retainedGraph(),baseline=structuredClone(f.graph),held=structuredClone(f),graph=structuredClone(f.graph);
 graph.nodes.find(node=>node.id===f.outside.id)!.status='blocked';
 const snapshots:GraphRevision[]=[];
 await expect(observe(graph.teamId,()=>graph,cursor=>({items:cursor==='0'?f.history:[],nextCursor:cursor==='0'?'1':cursor}),new Map(),revision=>snapshots.push(revision),{
  baseline,proposalId:graph.nodes[0]!.sourceRef.id,projectId:graph.nodes[0]!.projectId,workdayId:graph.nodes[0]!.workdayId!,
 })).rejects.toThrow('ACCEPTANCE_GRAPH_COMPONENT');
 expect(snapshots).toEqual([]);expect(f).toEqual(held);expect(baseline).toEqual(held.graph);
});
