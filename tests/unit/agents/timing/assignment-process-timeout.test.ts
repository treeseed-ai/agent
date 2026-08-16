import {describe,expect,it} from 'vitest';
import {assignmentProcessTimeoutSeconds} from '../../../../src/agents/kernel/execution/context-loader.ts';

describe('assignment provider process timeout',()=>{
	it('adds bounded preparation and closeout around the full productive allocation',()=>{
		expect(assignmentProcessTimeoutSeconds(900,{reservedSeconds:600,budget:{time:{preparationSeconds:180,closeoutSeconds:120}}} as never)).toBe(900);
	});
	it('keeps legacy envelopes bounded by productive reservation',()=>{
		expect(assignmentProcessTimeoutSeconds(900,{reservedSeconds:600} as never)).toBe(600);
	});
});
