import {expect,it} from 'vitest';
import {executionNodeSchema,executionEdgeSchema,graphRevisionSchema} from '@treeseed/sdk/agent-capacity';
import * as evidence from '../../../../acceptance/workday/support/evidence-pages.ts';
import {liveAssignmentGraph,liveAssignmentRecord} from '../live-assignment-fixture.ts';

export function retainedGraph(){
 const original=liveAssignmentGraph(liveAssignmentRecord()),nodes=executionNodeSchema.array().parse(original.nodes).map(node=>({...node,graphRevisionCreated:1,graphRevisionUpdated:1}));
 const outside={...structuredClone(nodes[1]!),id:'unrelated-original-component',sourceRef:{...nodes[1]!.sourceRef,id:'unrelated-original-proposal'}};nodes.push(outside);
 const edges=executionEdgeSchema.array().parse(original.edges).map(edge=>({...edge,graphRevisionCreated:1}));
 const graph={teamId:String(original.teamId),revision:1,digest:String(original.digest),nodes,edges};
 const history=[graphRevisionSchema.parse({schemaVersion:'treeseed.graph-revision/v1',teamId:graph.teamId,revision:1,ruleRevision:1,changedSourceRefs:[nodes[0]!.sourceRef,outside.sourceRef],graphDigest:graph.digest,createdAt:'2026-10-16T20:00:00.000Z',changes:{added:nodes.map(node=>node.id),changed:[],completed:[],blocked:[],stale:[],addedEdges:edges.map(edge=>edge.id),removedEdges:[]}})];
 return{graph,history,outside};
}

it('requires every original graph node birth and active edge to remain represented without rewriting unrelated components or prior history',()=>{
 const verify=Reflect.get(evidence,'verifyGraphRetention');expect(verify).toBeTypeOf('function');if(typeof verify!=='function')throw new Error('Original graph history/current inventory retention guard is missing');
 const exact=retainedGraph(),held=structuredClone(exact);verify(exact.graph,exact.history);expect(exact).toEqual(held);
 for(const mode of['lost-unrelated-node','unknown-node','duplicate-node','wrong-birth','lost-active-edge','unknown-edge','removed-active-edge','missing-nodes','missing-edges','foreign-history','gapped-history','duplicate-birth']){
  const f=retainedGraph();
  if(mode==='lost-unrelated-node')f.graph.nodes.pop();if(mode==='unknown-node')f.graph.nodes.push({...structuredClone(f.outside),id:'unrecorded-node'});if(mode==='duplicate-node')f.graph.nodes.push(structuredClone(f.outside));if(mode==='wrong-birth')f.graph.nodes[0]!.graphRevisionCreated=2;
  if(mode==='lost-active-edge')f.graph.edges=[];if(mode==='unknown-edge')f.graph.edges.push({...structuredClone(f.graph.edges[0]!),id:'unrecorded-edge'});if(mode==='removed-active-edge')f.history[0]!.changes.removedEdges.push(f.graph.edges[0]!.id);
  if(mode==='missing-nodes')Reflect.deleteProperty(f.graph,'nodes');if(mode==='missing-edges')Reflect.deleteProperty(f.graph,'edges');if(mode==='foreign-history')f.history[0]!.teamId='foreign';if(mode==='gapped-history')f.history[0]!.revision=2;
  if(mode==='duplicate-birth')f.history.push({...structuredClone(f.history[0]!),revision:2});
  const before=structuredClone(f);expect(()=>verify(f.graph,f.history),mode).toThrow('ACCEPTANCE_GRAPH_RETENTION');expect(f).toEqual(before);verify(exact.graph,exact.history);
 }
});
