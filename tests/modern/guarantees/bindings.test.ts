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
	it('binds the exact model clock criterion to complete post campaign native readback without substituting component evidence', () => {
		const manifest = parse(readFileSync(resolve(root, 'guarantees/agent/golden/sdk-complete.guarantee.yaml'), 'utf8'));
		expect(manifest.acceptanceCriteria).toEqual([{ criterion: 'b635827ed7862d56b8764dfad30114b9ee18d02b4aa709a257841e18a1bd0f0d',
			verifierRefs: ['agent.golden.execution-clock-observation-live-1'] }]);
		const scene = parse(readFileSync(resolve(root, manifest.scene.manifest), 'utf8'));
		expect(scene.scope).toBe('local-integrated-runtime');
		const refs = scene.workflow.map((step: { action: { verifier: string } }) => step.action.verifier);
		expect(refs.filter((ref: string) => ref === 'agent.golden.execution-clock-observation-live-1')).toHaveLength(1);
		expect(refs.indexOf('agent.golden.live.campaign')).toBeGreaterThan(-1);
		expect(refs.indexOf('agent.golden.execution-clock-observation-live-1')).toBeGreaterThan(refs.indexOf('agent.golden.live.campaign'));
		expect(registry.verifiers['agent.golden.execution-clock-observation-live-1']).toMatchObject({ kind: 'nodeTestCase',
			testFile: 'tests/acceptance/workday/context-custody.test.ts',
			testName: 'Every actual recorded model execution is included in exact clock evidence readback without discarding failed or returned attempts' });
	});
	it('supplies exact canonical execution authority before complete verification and inherited scene prerequisites', () => {
		const workflow = parse(readFileSync(resolve(root, '.github/workflows/verify.yml'), 'utf8'));
		const job = workflow.jobs.verify, steps = job.steps;
		const checkouts = steps.filter((step: { uses?: string; with?: { repository?: string } }) =>
			step.uses?.startsWith('actions/checkout@') && step.with?.repository === 'treeseed-ai/platform');
		expect(checkouts).toHaveLength(1);
		expect(checkouts[0].with).toMatchObject({ ref: 'e4c4cad1e526f53d3549c8fc27c3e60122b20ee4', path: '.treeseed/platform-authority', 'persist-credentials': false });
		expect(job.env.TREESEED_DEVELOPMENT_WORKSPACE_ROOT).toBe('${{ github.workspace }}/.treeseed/platform-authority');
		const verify = steps.findIndex((step: { run?: string }) => step.run?.includes('npm run verify:local'));
		const scene = steps.findIndex((step: { uses?: string }) => step.uses?.includes('reviewer/.github/actions/run-scenes@'));
		expect(steps[scene].uses).toBe('treeseed-ai/reviewer/.github/actions/run-scenes@ea16c08f3f70fcf27d2e1d816df26af23e84a4b4');
		expect(steps.indexOf(checkouts[0])).toBeLessThan(verify); expect(verify).toBeGreaterThan(-1); expect(scene).toBeGreaterThan(verify);
		const relay = steps.findIndex((step: { name?: string }) => step.name === 'Prepare disposable native relay CA');
		expect(relay).toBeGreaterThan(-1); expect(relay).toBeLessThan(verify);
		expect(steps[relay].run).toContain('openssl x509 -in "$relay_fixture/ca.pem" -noout -checkend 0');
		expect(steps[relay].run).toContain('sudo install -m 0644 "$relay_fixture/ca.pem" /etc/treeseed/sandbox/relay-ca.crt');
	});
	it('binds every registered verifier to an executable current implementation', () => {
		const failures: string[] = [];
		const namesByFile = new Map<string, string[]>();
		for (const [id, verifier] of Object.entries(registry.verifiers)) {
			const path = ['vitestCase', 'nodeTestCase'].includes(verifier.kind) ? verifier.testFile : verifier.command;
			if (!path || !existsSync(resolve(root, path))) {
				failures.push(`${id}: missing ${path ?? 'implementation'}`);
				continue;
			}
			if (['vitestCase', 'nodeTestCase'].includes(verifier.kind)) {
				if (verifier.kind === 'vitestCase' && !path.startsWith('tests/modern/')) failures.push(`${id}: excluded from the active Vitest suite`);
				if (verifier.kind === 'nodeTestCase' && !path.startsWith('tests/acceptance/')) failures.push(`${id}: not an explicit runtime acceptance test`);
				let names = namesByFile.get(path);
				if (!names) {
				const source = ts.createSourceFile(path, readFileSync(resolve(root, path), 'utf8'), ts.ScriptTarget.Latest, true);
				const collected: string[] = [];
				function inspect(node: ts.Node): void {
					if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
						&& ['it', 'test'].includes(node.expression.text) && node.arguments[0]
						&& ts.isStringLiteral(node.arguments[0])) collected.push(node.arguments[0].text);
					ts.forEachChild(node, inspect);
				}
				inspect(source);
				names = collected; namesByFile.set(path, names);
				}
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
				else if (entry.name.endsWith('.scene.yaml')) {
					const scene = parse(readFileSync(path, 'utf8')) as { scope?: string; workflow?: Array<{
						id?: string; demoOnly?: boolean; action?: { verifier?: string }; expect?: { status?: string } }> };
					if (!['local-component-tests', 'local-integrated-runtime'].includes(scene.scope ?? '')) continue;
					if (!scene.workflow?.length) { failures.push(`${path}: empty executable scene`); continue; }
					const ids = new Set<string>();
					for (const step of scene.workflow) {
						if (!step.id || ids.has(step.id) || step.demoOnly || !step.action?.verifier
							|| step.expect?.status !== 'passed') {
							failures.push(`${path}: invalid executable step ${step.id ?? '(missing)'}`);
						}
						if (step.id) ids.add(step.id);
					}
				}
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
