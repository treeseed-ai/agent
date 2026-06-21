import type { AgentHandler } from '../runtime-types.ts';
import { plannerHandler } from './planner.ts';

export const planHandler: AgentHandler = {
	...plannerHandler,
	kind: 'plan',
};

