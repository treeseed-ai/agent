import { expect, it } from 'vitest';
import { gate, state } from '../../golden-readback-fixture.ts';

it('denies missing or contradictory original work-review bytes even when parsed approval views agree', () => {
	const file = state.replies.get('library read decisions/approved-revision.mdx')!.result.files[0];
	expect(() => gate('graph')).not.toThrow(); const original = structuredClone(file);
	delete file.content; const held = structuredClone(file);
	expect(() => gate('graph')).toThrow(); expect(file).toEqual(held);
	Object.assign(file, original); expect(() => gate('graph')).not.toThrow();
});
