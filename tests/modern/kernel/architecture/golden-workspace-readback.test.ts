import { describe, expect, it } from 'vitest';
import { gate, state, type Row } from './golden-readback-fixture.ts';

const selected = (): Row => state.replies.get('assignments list')!.items[0];
const key = (): string => `workspace ${selected().assignmentAttempt.workspace.workspaceId}`;
// UNIT OF the actual managed verifier. These CLI replies are synthetic inputs,
// not actual TreeDX resources, physical workspaces or provider-session receipts.
describe('independent managed workspace closure readback', () => {
	it('reads each exact immutable TreeDX workspace through the supported command on every terminal check', () => {
		const before = structuredClone([...state.replies]); gate('settlement'); gate('settlement');
		const expected = state.replies.get('assignments list')!.items.filter((item: Row) => item.assignmentAttempt.workspace.mode === 'treedx');
		const calls = state.calls.filter(args => args.slice(0, 4).join(' ') === 'projects treedx workspaces show');
		expect(calls).toHaveLength(expected.length * 2);
		for (const item of expected) expect(calls.filter(args => args[4] === item.assignmentAttempt.workspace.workspaceId))
			.toEqual(Array.from({ length: 2 }, () => ['projects', 'treedx', 'workspaces', 'show', item.assignmentAttempt.workspace.workspaceId,
				'--project', item.projectId, '--server', 'local', '--json']));
		expect([...state.replies]).toEqual(before);
	});
	it('denies open foreign or malformed resource readback despite revoked handles and verified teardown', () => {
		const original = structuredClone(state.replies.get(key())!);
		const changes = [{ status: 'open' }, { status: 'expired' }, { workspaceId: 'foreign-workspace' },
			{ repoId: 'foreign-repository' }, { status: undefined }, { workspaceId: undefined }];
		const outcomes = changes.map(change => {
			state.replies.set(key(), { ...original, result: { ...original.result, ...change } });
			try { gate('settlement'); return 'ADMITTED'; } catch (error) { return String(error); }
		});
		expect(outcomes).toEqual(changes.map(() => expect.stringMatching(/ACCEPTANCE_WORKSPACE_READBACK/u)));
	});
	it('requires the exact project receipt and explicit workspace result rather than an empty success envelope', () => {
		const original = structuredClone(state.replies.get(key())!);
		const values = [{}, { result: null }, { ...original, receipt: {} }, { ...original, receipt: { projectId: 'foreign-project' } }];
		const outcomes = values.map(value => {
			state.replies.set(key(), value);
			try { gate('settlement'); return 'ADMITTED'; } catch (error) { return String(error); }
		});
		expect(outcomes).toEqual(values.map(() => expect.stringMatching(/ACCEPTANCE_WORKSPACE_READBACK/u)));
	});
	it('does not convert missing or denied workspace read authority into confirmed absence', () => {
		const original = state.replies.get(key())!;
		state.replies.delete(key());
		const outcomes: string[] = [];
		try { gate('settlement'); outcomes.push('ADMITTED'); } catch (error) { outcomes.push(String(error)); }
		state.replies.set(key(), original);
		for (const code of ['treedx_access_denied', 'treedx_workspace_verification_failed', 'not_found']) {
			state.workspaceFailure = Object.assign(new Error('Isolated workspace read failure'), { code: 1,
				stderr: JSON.stringify({ ok: false, error: { code } }) });
			try { gate('settlement'); outcomes.push('ADMITTED'); } catch (error) { outcomes.push(String(error)); }
		}
		expect(outcomes).toEqual(Array.from({ length: 4 }, () => expect.stringMatching(/ACCEPTANCE_CLI_COMMAND/u)));
	});
	it('denies missing immutable workspace authority and checks stopped cleanup without rewriting inputs', () => {
		const item = selected(), original = structuredClone(item.assignmentAttempt.workspace);
		item.assignmentAttempt.workspace = undefined;
		let outcome = 'ADMITTED'; try { gate('settlement'); } catch (error) { outcome = String(error); }
		item.assignmentAttempt.workspace = original;
		state.replies.get('workdays show')!.run.status = 'failed';
		const before = structuredClone([...state.replies]);
		expect(state.cases.get('Stopped simulation retains terminal leases teardown and exactly-once settlement')!).not.toThrow();
		expect([...state.replies]).toEqual(before);
		expect(outcome).toMatch(/ACCEPTANCE_WORKSPACE_AUTHORITY/u);
	});
});
