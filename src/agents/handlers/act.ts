import type { AgentHandler } from '../runtime-types.ts';
import { engineerHandler } from './engineer.ts';

export const actHandler: AgentHandler = {
	...engineerHandler,
	kind: 'act',
};

