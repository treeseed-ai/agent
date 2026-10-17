import {executionNodeSchema,executionEdgeSchema,graphRevisionSchema} from '@treeseed/sdk/agent-capacity';
import {liveAssignmentGraph,liveAssignmentRecord} from '../live-assignment-fixture.ts';

export function retainedGraph(){
 const original=liveAssignmentGraph(liveAssignmentRecord()),nodes=executionNodeSchema.array().parse(original.nodes).map(node=>({...node,graphRevisionCreated:1,graphRevisionUpdated:1}));
 const outside={...structuredClone(nodes[1]!),id:'unrelated-original-component',sourceRef:{...nodes[1]!.sourceRef,id:'unrelated-original-proposal'}};nodes.push(outside);
 const edges=executionEdgeSchema.array().parse(original.edges).map(edge=>({...edge,graphRevisionCreated:1}));
 const graph={teamId:String(original.teamId),revision:1,digest:String(original.digest),nodes,edges};
 const history=[graphRevisionSchema.parse({schemaVersion:'treeseed.graph-revision/v1',teamId:graph.teamId,revision:1,ruleRevision:1,changedSourceRefs:[nodes[0]!.sourceRef,outside.sourceRef],graphDigest:graph.digest,createdAt:'2026-10-16T20:00:00.000Z',changes:{added:nodes.map(node=>node.id),changed:[],completed:[],blocked:[],stale:[],addedEdges:edges.map(edge=>edge.id),removedEdges:[]}})];
 return{graph,history,outside};
}
