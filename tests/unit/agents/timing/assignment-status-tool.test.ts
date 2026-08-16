import { describe,expect,it } from 'vitest';
import { readAssignmentStatus } from '../../../../src/agents/tools/status/assignment-status-tool.ts';

function response(remainingSeconds: number) {
	const now = new Date('2026-08-12T14:00:00.000Z');
	const deadline = new Date(now.getTime() + remainingSeconds * 1_000).toISOString();
	return {
		options: {
			apiBaseUrl: 'http://api.test', providerAccessToken: 'secret', assignmentId: 'assignment-1', now: () => now,
			fetchImpl: async () => new Response(JSON.stringify({ ok:true,payload:{
				id:'assignment-1',workDayId:'workday-1',projectId:'project-1',agentId:'engineer',projectAgentClassId:'engineering',
				status:'running',leaseState:'leased',assignedAt:'2026-08-12T13:55:00.000Z',reservationId:'reservation-1',
				capacityEnvelope:{ reservedSeconds:900,budget:{ deadline,time:{ hardDeadlineAt:deadline,closeoutWarningSeconds:120 } } },
				decisionInput:{ input:{ activityType:'acting' } },metadata:{ workdayRunId:'run-1' },
			} }), { status:200,headers:{ 'content-type':'application/json' } }),
		},
		deadline,
	};
}

describe('assignment status time contract', () => {
	it('separates preparation, productive execution, and protected closeout',async()=>{
		const now=new Date('2026-08-12T14:00:00.000Z');
		const options={ apiBaseUrl:'http://api.test',providerAccessToken:'secret',assignmentId:'assignment-1',now:()=>now,fetchImpl:async()=>Response.json({ok:true,payload:{ id:'assignment-1',projectId:'project-1',status:'leased',leaseState:'leased',capacityEnvelope:{reservedSeconds:600,budget:{time:{requestedSeconds:600,executionSeconds:600,preparationSeconds:180,closeoutSeconds:120,preparationDeadlineAt:'2026-08-12T14:03:00.000Z',executionStartedAt:null,executionDeadlineAt:null,closeoutDeadlineAt:'2026-08-12T14:05:00.000Z'}}},decisionInput:{},metadata:{} }}) };
		await expect(readAssignmentStatus(options)).resolves.toMatchObject({payload:{time:{phase:'preparation',preparationRemainingSeconds:180,executionRemainingSeconds:600,remainingSeconds:180}}});
	});
	it('returns authoritative wall-clock assignment timing while work continues', async () => {
		const input = response(121);
		await expect(readAssignmentStatus(input.options)).resolves.toMatchObject({ ok:true,payload:{ time:{
			now:'2026-08-12T14:00:00.000Z',startedAt:'2026-08-12T13:55:00.000Z',deadlineAt:input.deadline,
			allocatedSeconds:900,remainingSeconds:121,closeoutWarningSeconds:120,phase:'working',shouldCloseOut:false,
		} } });
	});

	it('requires closeout at the configured threshold and reports expiration', async () => {
		await expect(readAssignmentStatus(response(120).options)).resolves.toMatchObject({ payload:{ time:{ phase:'closeout',shouldCloseOut:true,remainingSeconds:120 } } });
		await expect(readAssignmentStatus(response(0).options)).resolves.toMatchObject({ payload:{ time:{ phase:'expired',shouldCloseOut:true,remainingSeconds:0 } } });
	});
});
