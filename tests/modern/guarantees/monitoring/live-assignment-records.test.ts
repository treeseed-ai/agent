import { describe, expect, it, vi } from 'vitest';
import { row, type Row } from '../../../acceptance/acceptance-cli.ts';
import { observeLiveAssignmentRecords } from '../../../acceptance/workday/support/monitoring/live-assignment-records.ts';
import { liveAssignmentRecord, liveRun } from './live-assignment-fixture.ts';

describe('live canonical assignment observation (controlled inputs, not managed proof)', () => {
	it('observes empty initial admission then every new canonical attempt once without changing input or repeating independent inspection', () => {
		const item = liveAssignmentRecord(), run = liveRun(item), before = structuredClone({ item, run }), retained = new Map<string, Row>(), inspect = vi.fn();
		observeLiveAssignmentRecords(run, [], retained, inspect);
		for (let i = 0; i < 3; i++) observeLiveAssignmentRecords(run, [item], retained, inspect);
		expect(inspect).toHaveBeenCalledExactlyOnceWith(item); expect(retained.get(String(item.id))).toEqual(item.assignmentAttempt);
		expect({ item, run }).toEqual(before); expect(retained.get(String(item.id))).not.toBe(item.assignmentAttempt);
	});
	it('denies malformed foreign duplicated unselected or unauthorized canonical rows before any new inspection and preserves observations', () => {
		for (const mode of ['attempt', 'retired', 'team', 'workday', 'project', 'duplicate', 'clock', 'deadline', 'grant', 'workspace', 'context', 'mode']) {
			const item = liveAssignmentRecord(), run = liveRun(item), retained = new Map<string, Row>(), inspect = vi.fn();
			observeLiveAssignmentRecords(run, [item], retained, inspect); inspect.mockClear();
			const changed = structuredClone(item), attempt = row(changed.assignmentAttempt); const items = [changed];
			if (mode === 'attempt') attempt.id = 'foreign'; if (mode === 'retired') changed.decisionInput = {};
			if (mode === 'team') run.teamId = 'foreign'; if (mode === 'workday') run.id = 'foreign';
			if (mode === 'project') row(run.parameters).scheduledProjectIds = ['foreign']; if (mode === 'duplicate') items.push(changed);
			if (mode === 'clock') run.startedAt = '2099-09-14T00:00:00.000Z'; if (mode === 'deadline') attempt.deadline = attempt.createdAt;
			if (mode === 'grant') row(attempt.grant).tools = ['source.read', 'source.write', 'release'];
			if (mode === 'workspace') attempt.workspace = { mode: 'read-only' }; if (mode === 'context') attempt.contextRefs = [];
			if (mode === 'mode') run.executionMode = 'production';
			const before = structuredClone({ items, run, retained });
			expect(() => observeLiveAssignmentRecords(run, items, retained, inspect), mode).toThrow();
			expect(inspect, mode).not.toHaveBeenCalled(); expect({ items, run, retained }, mode).toEqual(before);
		}
	});
	it('denies every changed issued authority field and disappearance while allowing only API lifecycle advancement with stable original clocks', () => {
		const item = liveAssignmentRecord(), run = liveRun(item), retained = new Map<string, Row>(), inspect = vi.fn();
		observeLiveAssignmentRecords(run, [item], retained, inspect);
		for (const field of ['idempotencyKey', 'nodeId', 'nodeRevision', 'graphRevision', 'sourceRef', 'authorityRefs', 'effectiveProfile', 'requiredCapabilities',
			'grant', 'provider', 'contextRefs', 'predecessorResultIds', 'acceptanceCriteria', 'workspace', 'estimate', 'limits', 'deadline', 'leaseId', 'reservationId', 'attempt']) {
			const changed = structuredClone(item); row(changed.assignmentAttempt)[field] = null;
			const before = structuredClone(retained); expect(() => observeLiveAssignmentRecords(run, [changed], retained, inspect), field).toThrow(); expect(retained).toEqual(before);
		}
		const changed = structuredClone(item); row(row(changed.assignmentAttempt).provider).runtimeBuild = `sha256:${'f'.repeat(64)}`;
		expect(() => observeLiveAssignmentRecords(run, [changed], retained, inspect)).toThrow('Issued authority changed');
		expect(() => observeLiveAssignmentRecords(run, [], retained, inspect)).toThrow('disappeared');
		const running = structuredClone(item); row(running.assignmentAttempt).status = 'running'; row(running.assignmentAttempt).startedAt = running.createdAt;
		observeLiveAssignmentRecords(run, [running], retained, inspect);
		for (const value of [undefined, '2026-09-13T12:00:01.000Z']) {
			const moved = structuredClone(running); row(moved.assignmentAttempt).startedAt = value;
			expect(() => observeLiveAssignmentRecords(run, [moved], retained, inspect)).toThrow('Original lifecycle clock changed');
		}
		expect(inspect).toHaveBeenCalledOnce();
	});
	it('preserves the original independent inspection failure and prior batch through denial and exact retry', () => {
		const item = liveAssignmentRecord(), run = liveRun(item), retained = new Map<string, Row>(), original = new Error('controlled_denial');
		const before = structuredClone({ item, run, retained });
		expect(() => observeLiveAssignmentRecords(run, [item], retained, () => { throw original; })).toThrow(original);
		expect({ item, run, retained }).toEqual(before);
		observeLiveAssignmentRecords(run, [item], retained, () => {}); expect(retained.size).toBe(1);
	});
});
