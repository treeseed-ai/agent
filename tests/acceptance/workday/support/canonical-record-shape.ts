import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { row, type Row } from '../../acceptance-cli.ts';

// The existing target-derived assertion, extracted only to keep the owning
// custody file below its 500-line limit. No copied model or new runtime policy.
let authority: { root: string; head: string; bytes: string; definitions: Row } | undefined;
function definitions(): Row {
	if (!authority) {
		const root = process.env.TREESEED_DEVELOPMENT_WORKSPACE_ROOT;
		assert.ok(root, 'ACCEPTANCE_CANONICAL_INPUT: Exact existing development workspace authority required');
		const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
		const bytes = readFileSync(resolve(root, 'docs/agent.schema.yml'), 'utf8');
		assert.equal(bytes, execFileSync('git', ['show', `${head}:docs/agent.schema.yml`], { cwd: root, encoding: 'utf8' }), 'ACCEPTANCE_CANONICAL_INPUT: Canonical bytes differ from tracked authority');
		authority = { root, head, bytes, definitions: row(row(parse(bytes)).$defs) };
	}
	assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: authority.root, encoding: 'utf8' }).trim(), authority.head);
	assert.equal(readFileSync(resolve(authority.root, 'docs/agent.schema.yml'), 'utf8'), authority.bytes);
	return authority.definitions;
}

function declared(value: unknown, input: Row, path: string, target: Row): void {
	const spec = typeof input.$ref === 'string' ? row(target[input.$ref.slice('#/$defs/'.length)]) : input;
	if (Object.hasOwn(spec, 'const')) assert.equal(value, spec.const, `ACCEPTANCE_CANONICAL_SHAPE: ${path}`);
	if (Array.isArray(spec.enum)) assert.ok(spec.enum.includes(value), `ACCEPTANCE_CANONICAL_SHAPE: ${path}`);
	if (spec.type === 'object') {
		assert.ok(value && typeof value === 'object' && !Array.isArray(value), `ACCEPTANCE_CANONICAL_SHAPE: ${path}`);
		const record = row(value), properties = row(spec.properties), required = spec.required;
		assert.ok(Array.isArray(required) || required === undefined);
		if (Array.isArray(required)) for (const key of required) assert.ok(typeof key === 'string' && Object.hasOwn(record, key), `ACCEPTANCE_CANONICAL_SHAPE: ${path}.${String(key)}`);
		for (const [key, child] of Object.entries(record)) {
			if (Object.hasOwn(properties, key)) declared(child, row(properties[key]), `${path}.${key}`, target);
			else {
				assert.notEqual(spec.additionalProperties, false, `ACCEPTANCE_CANONICAL_SHAPE: ${path}.${key}`);
				if (spec.additionalProperties && typeof spec.additionalProperties === 'object') declared(child, row(spec.additionalProperties), `${path}.${key}`, target);
			}
		}
	}
	if (spec.type === 'string') {
		assert.equal(typeof value, 'string', `ACCEPTANCE_CANONICAL_SHAPE: ${path}`); const text = String(value);
		if (typeof spec.minLength === 'number') assert.ok(text.length >= spec.minLength);
		if (typeof spec.maxLength === 'number') assert.ok(text.length <= spec.maxLength);
		if (typeof spec.pattern === 'string') assert.match(text, new RegExp(spec.pattern, 'u'));
		if (spec.format === 'date-time') {
			assert.ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(text)
				&& Number.isFinite(Date.parse(text)), `ACCEPTANCE_CANONICAL_SHAPE: ${path}`);
			assert.equal(new Date(`${text.slice(0, 10)}T00:00:00.000Z`).toISOString().slice(0, 10), text.slice(0, 10), `ACCEPTANCE_CANONICAL_SHAPE: ${path}`);
		}
	}
	if (spec.type === 'number' || spec.type === 'integer') {
		assert.ok(typeof value === 'number' && Number.isFinite(value), `ACCEPTANCE_CANONICAL_SHAPE: ${path}`);
		if (spec.type === 'integer') assert.ok(Number.isInteger(value));
		if (typeof spec.minimum === 'number') assert.ok(value >= spec.minimum);
		if (typeof spec.exclusiveMinimum === 'number') assert.ok(value > spec.exclusiveMinimum);
	}
}

export function assertCanonicalRecordShapes(groups: ReadonlyArray<readonly [string, Row[]]>): void {
	const target = definitions();
	for (const [name, records] of groups) {
		assert.ok(target[name], `ACCEPTANCE_CANONICAL_INPUT: Target lacks ${name}`);
		for (const record of records) declared(record, row(target[name]), name, target);
	}
	// Source custody is held across the complete synchronous traversal, not
	// weakened by caching or by reading one field from a different revision.
	assert.equal(definitions(), target);
}
