import { createHash } from 'node:crypto';
import { stringify } from 'yaml';
import { assignmentAttemptSchema } from '@treeseed/sdk/agent-capacity';
import { request } from '../../../provider-kernel-fixture.ts';
import { portableProfile } from '../../portable/portable-kernel-fixture.ts';

export const profileOrderFailures = ['missing', 'extra', 'duplicate', 'actor', 'class', 'source', 'team', 'project', 'removed', 'foreign', 'work-item'] as const;
export function profileOrderFixture(dependencies = ['earlier-configured-class']) {
	const definition = portableProfile(), activity = definition.activityProfiles.acting!;
	activity.dependsOn = { agents: dependencies };
	const content = stringify(definition), path = 'agents/renamed-author.yaml';
	const attempt = assignmentAttemptSchema.parse({ ...assignmentAttemptSchema.parse(request().assignment.assignmentAttempt), agentClass: definition.agentClass,
		effectiveProfile: { profileRef: { store: 'treedx', model: 'agent', id: definition.id, revision: 1,
			digest: `sha256:${createHash('sha256').update(content).digest('hex')}`, repository: 'native-library', commit: 'a'.repeat(40), path },
			activity: 'acting', handler: activity.handler, handlerOrigin: 'agent-package', prompt: activity.prompt,
			parameters: activity.parameters, permissionCeiling: activity.permissions } });
	const actor = { id: attempt.nodeId, teamId: attempt.teamId, projectId: attempt.projectId, workItemId: attempt.workItemId,
		sourceRef: attempt.sourceRef, agentClass: attempt.agentClass, pairRole: 'actor' };
	const predecessor = { ...actor, id: 'earlier-actor', workItemId: 'earlier-work', agentClass: 'earlier-configured-class' };
	const reviewer = { ...predecessor, id: 'earlier-reviewer', agentClass: 'reviewer', pairRole: 'reviewer' };
	const edge = { schemaVersion: 'treeseed.execution-edge/v1', id: 'profile-edge', teamId: attempt.teamId,
		fromNodeId: reviewer.id, toNodeId: actor.id, provenance: 'profile-agent', sourceRef: attempt.sourceRef, graphRevisionCreated: 1 };
	return { item: { id: attempt.id, assignmentAttempt: attempt }, file: { path, content },
		graph: { teamId: attempt.teamId, nodes: [actor, predecessor, reviewer], edges: [edge] } };
}
export function mutateProfileOrder(graph: ReturnType<typeof profileOrderFixture>['graph'], mode: string): void {
	const edge = graph.edges[0]!;
	if (mode === 'missing') graph.edges = [];
	else if (mode === 'extra') graph.edges.push({ ...edge, id: 'extra-edge', fromNodeId: 'unrelated-reviewer' });
	else if (mode === 'duplicate') graph.edges.push(structuredClone(edge));
	else if (mode === 'actor') edge.fromNodeId = 'earlier-actor';
	else if (mode === 'class') graph.nodes[1]!.agentClass = 'foreign-class';
	else if (mode === 'source') edge.sourceRef = { ...edge.sourceRef, revision: 2 };
	else if (mode === 'team') edge.teamId = 'foreign-team';
	else if (mode === 'project') graph.nodes[1]!.projectId = 'foreign-project';
	else if (mode === 'removed') Reflect.set(edge, 'graphRevisionRemoved', 2);
	else if (mode === 'foreign') edge.fromNodeId = 'foreign-node';
	else if (mode === 'work-item') edge.provenance = 'work-item';
}
