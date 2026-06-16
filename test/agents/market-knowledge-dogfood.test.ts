import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runMarketKnowledgeDogfood } from '../../src/agents/testing/market-knowledge-dogfood.ts';
import { TREESEED_PLATFORM_KNOWLEDGE_QUESTIONS } from '../../src/agents/knowledge/pipeline.ts';

const tempRoots: string[] = [];

function writeFile(root: string, relativePath: string, source: string) {
	const fullPath = resolve(root, relativePath);
	mkdirSync(resolve(fullPath, '..'), { recursive: true });
	writeFileSync(fullPath, source, 'utf8');
}

function runGit(root: string, args: string[]) {
	return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function createDogfoodRepo() {
	const root = mkdtempSync(resolve(tmpdir(), 'treeseed-market-dogfood-'));
	tempRoots.push(root);
	for (const directory of [
		'knowledge/architecture',
		'knowledge/developer',
		'knowledge/research',
		'knowledge/operations',
		'questions',
		'objectives',
	]) {
		mkdirSync(resolve(root, 'src/content', directory), { recursive: true });
	}
	writeFile(root, 'src/content/objectives/tree-seed-agent-self-development.mdx', `---
id: objective:tree-seed-agent-self-development
title: TreeSeed Agent Self Development
status: planned
tags: [agent, knowledge]
---

Build the agent processing platform through traceable knowledge work.
`);
	writeFile(root, 'src/content/knowledge/architecture/agent-runtime.mdx', `---
id: knowledge:agent-runtime
title: Agent Runtime
type: architecture
status: canonical
tags: [agent, runtime, workday]
related:
  - knowledge:worker-runtime
---

The AgentKernel runs tenant handlers with execution, mutation, verification, and research adapters.
`);
	writeFile(root, 'src/content/knowledge/developer/local-workdays.mdx', `---
id: knowledge:local-workdays
title: Local Workdays
type: guide
status: live
tags: [workday, manager, worker]
references:
  - knowledge:agent-runtime
---

Local workdays start manager and worker services, seed tasks, and produce reports.
`);
writeFile(root, 'src/content/knowledge/research/research-to-knowledge.mdx', `---
id: knowledge:research-to-knowledge
title: Research To Knowledge
type: guide
status: draft
tags: [research, knowledge, questions]
references:
  - objective:tree-seed-agent-self-development
---

Research notes preserve source context before knowledge drafts are generated.
`);
	writeFile(root, 'src/content/knowledge/developer/codex-provider.mdx', `---
id: knowledge:codex-provider
title: Codex Subscription Provider
type: provider
status: draft
tags: [codex, provider, verification]
references:
  - knowledge:agent-runtime
---

The Codex subscription provider reports readiness, wraps prompts, and stays behind approval and worktree boundaries.
`);
	writeFile(root, 'src/content/knowledge/operations/agent-supervision.mdx', `---
id: knowledge:agent-supervision
title: Agent Supervision
type: operations
status: draft
tags: [agents, approvals, workday]
references:
  - knowledge:local-workdays
---

The Market agents page surfaces generated knowledge, pending promotion requests, Codex readiness, and workday reports.
`);
	runGit(root, ['init', '-b', 'main']);
	runGit(root, ['config', 'user.email', 'dogfood@example.test']);
	runGit(root, ['config', 'user.name', 'Dogfood Test']);
	writeFileSync(resolve(root, '.git/info/exclude'), '.agent-worktrees/\n', 'utf8');
	runGit(root, ['add', '.']);
	runGit(root, ['commit', '-m', 'test: seed dogfood repo']);
	return root;
}

describe('market knowledge dogfood harness', () => {
	afterEach(() => {
		for (const root of tempRoots.splice(0)) {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it('runs planner, researcher, knowledge generator, and optimizer into feature worktrees only', async () => {
		const repoRoot = createDogfoodRepo();
		const result = await runMarketKnowledgeDogfood({
			repoRoot,
			now: new Date('2026-05-13T12:00:00.000Z'),
		});

		expect(result.stages).toEqual(['planner', 'researcher', 'knowledge_generator', 'optimizer']);
		expect(result.generated).toHaveLength(TREESEED_PLATFORM_KNOWLEDGE_QUESTIONS.length);
		expect(result.generated.map((generated) => generated.questionId)).toEqual(
			TREESEED_PLATFORM_KNOWLEDGE_QUESTIONS.map((question) => question.id),
		);
		expect(result.generated.map((generated) => generated.knowledgeDraft.targetPath)).toEqual(
			TREESEED_PLATFORM_KNOWLEDGE_QUESTIONS.map((question) => question.targetPath),
		);
		expect(result.releaseAttempted).toBe(false);
		expect(result.stagingAttempted).toBe(false);

		for (const generated of result.generated) {
			expect(generated.contextQueryIds.length).toBeGreaterThan(0);
			expect(generated.researchNote.contextQueries.length).toBeGreaterThan(0);
			expect(generated.optimizationReport.totalScore).toBeGreaterThanOrEqual(26);
			expect(generated.mutation.worktreePath).toContain('.agent-worktrees');
			expect(existsSync(resolve(generated.mutation.worktreePath!, generated.knowledgeDraft.targetPath))).toBe(true);
			expect(existsSync(resolve(repoRoot, generated.knowledgeDraft.targetPath))).toBe(false);
			const generatedSource = readFileSync(resolve(generated.mutation.worktreePath!, generated.knowledgeDraft.targetPath), 'utf8');
			expect(generatedSource).toContain('generated_by: treeseed-agent');
			expect(generatedSource).toContain('## Source map');
		}

		expect(runGit(repoRoot, ['status', '--porcelain'])).toBe('');
	}, 20_000);
});
