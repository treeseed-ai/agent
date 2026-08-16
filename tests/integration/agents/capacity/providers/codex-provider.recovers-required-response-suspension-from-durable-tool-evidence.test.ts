import {describe,expect,it} from 'vitest';
import {hasRequiredResponseSuspensionReceipt} from '../../../../../src/agents/adapters/reconciliation/execution-codex-adapter.ts';

describe('Codex required-response suspension evidence',()=>{
	it('accepts only the successful exact required-response tool receipt',()=>{
		expect(hasRequiredResponseSuspensionReceipt([{
			status:'completed',toolId:'treeseed.discussion.respond',
			inputSummary:{requiredResponse:true},outputSummary:{ok:true,suspended:true},
		}])).toBe(true);
		expect(hasRequiredResponseSuspensionReceipt([{
			status:'failed',toolId:'treeseed.discussion.respond',
			inputSummary:{requiredResponse:true},outputSummary:{suspended:true},
		}])).toBe(false);
		expect(hasRequiredResponseSuspensionReceipt([{
			status:'completed',toolId:'treeseed.discussion.respond',
			inputSummary:{requiredResponse:false},outputSummary:{ok:true,suspended:false},
		}])).toBe(false);
	});
});
