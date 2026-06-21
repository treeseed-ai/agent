import type { AgentHandler } from '../runtime-types.ts';
import { researcherHandler } from './researcher.ts';

export const researchHandler: AgentHandler = {
	...researcherHandler,
	kind: 'research',
};

