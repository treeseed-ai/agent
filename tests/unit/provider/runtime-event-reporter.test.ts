import { describe,expect,it,vi } from 'vitest';
import { reportProviderRuntimeEvent } from '../../../src/provider/reporting/runtime-event-reporter.ts';

const event = {
	id: 'event-1', eventType: 'provider.execution.started' as const, status: 'active' as const,
	component: 'execution-provider' as const, message: 'Codex invocation started.',
};

describe('provider runtime event reporting', () => {
	it('delivers a typed runtime event once', async () => {
		const createAssignmentEvent = vi.fn().mockResolvedValue({ ok: true });
		const delivered = await reportProviderRuntimeEvent({ client: { createAssignmentEvent } as never, assignmentId: 'assignment-1', event });
		expect(delivered).toBe(true);
		expect(createAssignmentEvent).toHaveBeenCalledOnce();
	});

	it('retries interrupted delivery without failing assignment execution', async () => {
		const createAssignmentEvent = vi.fn().mockRejectedValue(new Error('offline'));
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		const delivered = await reportProviderRuntimeEvent({ client: { createAssignmentEvent } as never, assignmentId: 'assignment-1', event });
		expect(delivered).toBe(false);
		expect(createAssignmentEvent).toHaveBeenCalledTimes(3);
		expect(error).toHaveBeenCalledWith(expect.stringContaining('provider.runtime_event_delivery_failed'));
		error.mockRestore();
	});
});
