import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../../..');
type Verifier = { kind: string; testFile?: string; testName?: string; command?: string };
const registry: { verifiers: Record<string, Verifier> } = { verifiers: {} };
for (const file of readdirSync(resolve(root, 'guarantees/verifiers')).filter(path => path.endsWith('.verifiers.yaml'))) {
	const document = parse(readFileSync(resolve(root, 'guarantees/verifiers', file), 'utf8')) as { verifiers: Record<string, Verifier> };
	for (const [id, definition] of Object.entries(document.verifiers)) {
		if (registry.verifiers[id]) throw new Error(`Duplicate guarantee verifier ${id}`);
		registry.verifiers[id] = definition;
	}
}

describe('capacity-provider guarantee execution bindings', () => {
	it('binds every registered verifier to an executable current implementation', () => {
		const failures: string[] = [];
		for (const [id, verifier] of Object.entries(registry.verifiers)) {
			const path = ['vitestCase', 'nodeTestCase'].includes(verifier.kind) ? verifier.testFile : verifier.command;
			if (!path || !existsSync(resolve(root, path))) {
				failures.push(`${id}: missing ${path ?? 'implementation'}`);
				continue;
			}
			if (['vitestCase', 'nodeTestCase'].includes(verifier.kind)) {
				if (verifier.kind === 'vitestCase' && !path.startsWith('tests/modern/')) failures.push(`${id}: excluded from the active Vitest suite`);
				if (verifier.kind === 'nodeTestCase' && !path.startsWith('tests/acceptance/')) failures.push(`${id}: not an explicit runtime acceptance test`);
				const source = ts.createSourceFile(path, readFileSync(resolve(root, path), 'utf8'), ts.ScriptTarget.Latest, true);
				const names: string[] = [];
				function inspect(node: ts.Node): void {
					if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
						&& ['it', 'test'].includes(node.expression.text) && node.arguments[0]
						&& ts.isStringLiteral(node.arguments[0])) names.push(node.arguments[0].text);
					ts.forEachChild(node, inspect);
				}
				inspect(source);
				if (!verifier.testName || !names.includes(verifier.testName)) failures.push(`${id}: missing active named case ${verifier.testName ?? '(unspecified)'}`);
			}
		}
		expect(failures, failures.join('\n')).toEqual([]);
	});
	it('resolves every guarantee verifier reference without silently ignoring planned contracts', () => {
		const failures: string[] = [];
		function visit(directory: string): void {
			for (const entry of readdirSync(directory, { withFileTypes: true })) {
				const path = resolve(directory, entry.name);
				if (entry.isDirectory()) visit(path);
				else if (entry.name.endsWith('.guarantee.yaml')) {
					const guarantee = parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
					function references(value: unknown): void {
						if (!value || typeof value !== 'object') return;
						for (const [key, child] of Object.entries(value)) {
							if (key === 'verifierRefs' && Array.isArray(child)) {
								for (const id of child) if (typeof id !== 'string' || !registry.verifiers[id])
									failures.push(`${guarantee.id}: unregistered ${String(id)}`);
							} else references(child);
						}
					}
					references(guarantee);
				}
			}
		}
		visit(resolve(root, 'guarantees'));
		expect([...new Set(failures)], [...new Set(failures)].join('\n')).toEqual([]);
	});
});
