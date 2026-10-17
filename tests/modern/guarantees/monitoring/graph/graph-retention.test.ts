import {expect,it} from 'vitest';
import * as evidence from '../../../../acceptance/workday/support/evidence-pages.ts';
import {retainedGraph} from './graph-retention-fixture.ts';


it('requires every original graph node birth and active edge to remain represented without rewriting unrelated components or prior history',()=>{
 const verify=Reflect.get(evidence,'verifyGraphRetention');expect(verify).toBeTypeOf('function');if(typeof verify!=='function')throw new Error('Original graph history/current inventory retention guard is missing');
 const exact=retainedGraph(),held=structuredClone(exact);verify(exact.graph,exact.history);expect(exact).toEqual(held);
 for(const mode of['lost-unrelated-node','unknown-node','duplicate-node','wrong-birth','lost-active-edge','unknown-edge','removed-active-edge','missing-nodes','missing-edges','foreign-history','gapped-history','duplicate-birth','foreign-node','future-node','foreign-edge','duplicate-edge','removed-unknown-edge']){
  const f=retainedGraph();
  if(mode==='lost-unrelated-node')f.graph.nodes.pop();if(mode==='unknown-node')f.graph.nodes.push({...structuredClone(f.outside),id:'unrecorded-node'});if(mode==='duplicate-node')f.graph.nodes.push(structuredClone(f.outside));if(mode==='wrong-birth')f.graph.nodes[0]!.graphRevisionCreated=2;
  if(mode==='lost-active-edge')f.graph.edges=[];if(mode==='unknown-edge')f.graph.edges.push({...structuredClone(f.graph.edges[0]!),id:'unrecorded-edge'});if(mode==='removed-active-edge')f.history[0]!.changes.removedEdges.push(f.graph.edges[0]!.id);
  if(mode==='missing-nodes')Reflect.deleteProperty(f.graph,'nodes');if(mode==='missing-edges')Reflect.deleteProperty(f.graph,'edges');if(mode==='foreign-history')f.history[0]!.teamId='foreign';if(mode==='gapped-history')f.history[0]!.revision=2;
  if(mode==='duplicate-birth'){f.graph.revision=2;f.history.push({...structuredClone(f.history[0]!),revision:2});}
  if(mode==='foreign-node')f.graph.nodes[0]!.teamId='foreign';if(mode==='future-node')f.graph.nodes[0]!.graphRevisionUpdated=2;if(mode==='foreign-edge')f.graph.edges[0]!.teamId='foreign';if(mode==='duplicate-edge')f.graph.edges.push(structuredClone(f.graph.edges[0]!));if(mode==='removed-unknown-edge')f.history[0]!.changes.removedEdges.push('unknown-edge');
  const before=structuredClone(f);expect(()=>verify(f.graph,f.history),mode).toThrow('ACCEPTANCE_GRAPH_RETENTION');expect(f).toEqual(before);verify(exact.graph,exact.history);
 }
 const removed=retainedGraph(),birth=removed.history[0]!,edge=structuredClone(removed.graph.edges[0]!);
 const emptyChanges={added:[],changed:[],completed:[],blocked:[],stale:[],removedEdges:[],addedEdges:[]};
 removed.graph.revision=2;removed.graph.edges=[];removed.history.push({...structuredClone(birth),revision:2,changes:{...emptyChanges,removedEdges:[edge.id]}});
 verify(removed.graph,removed.history);const retained=structuredClone(removed);expect(removed).toEqual(retained);
 removed.graph.revision=3;removed.graph.edges=[edge];removed.history.push({...structuredClone(birth),revision:3,changes:{...emptyChanges,addedEdges:[edge.id]}});
 const reactivated=structuredClone(removed);verify(removed.graph,removed.history);expect(removed).toEqual(reactivated);expect(removed.graph.edges[0]!.graphRevisionCreated).toBe(1);

});
