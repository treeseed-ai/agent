import { describe, expect, it } from 'vitest';
import { safeCliFailureCode } from '../../acceptance/acceptance-cli.ts';

describe('acceptance CLI failure classification', () => {
	it('keeps a safe structured error from stderr when the CLI exits without stdout', () => {
		expect(safeCliFailureCode('', JSON.stringify({ ok: false, error: { code: 'discussion_authoring_changeset_conflict' } }), 1))
			.toBe('discussion_authoring_changeset_conflict');
	});
	it('does not reveal error prose or unsafe codes', () => {
		expect(safeCliFailureCode('', JSON.stringify({ error: { code: 'secret=abc', message: 'private credential' } }), 1))
			.toBe('COMMAND_FAILED');
	});
});
