import type { AgentHandler } from '../runtime-types.ts';
import { reviewerHandler } from './reviewer.ts';

export const reviewHandler: AgentHandler = {
	...reviewerHandler,
	kind: 'review',
};

