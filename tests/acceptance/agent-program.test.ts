import { test, expect } from 'bun:test';
import type { AgentExecutionRequest } from '@treeseed-cordis/sdk';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
class AgentProgramAcceptance {
  private readonly binding = {
    scopeId: 'installation:fixture:agent',
    principalId: 'subject:fixture',
    resourceScope: 'installation:fixture',
    grantId: 'grant:fixture',
    grantRevision: 1,
    state: 'granted',
  };
  selected(): void {
    const root = mkdtempSync(join(tmpdir(), 'agent-program-'));
    try {
      const configuration = this.prepare(root);
      const status = this.describe(configuration);
      const request = this.request(status.generation);
      this.probe(configuration, request);
      this.human(configuration, request);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
  private prepare(root: string): string {
    const authorityFile = join(root, 'grant.json');
    const configuration = join(root, 'configuration.json');
    writeFileSync(authorityFile, JSON.stringify(this.binding), { mode: 0o600 });
    writeFileSync(configuration, JSON.stringify({ binding: this.binding, authorityFile }), {
      mode: 0o600,
    });
    return configuration;
  }
  private describe(configuration: string): { generation: string } {
    const described = spawnSync(
      'node',
      [resolve('dist/src/main.js'), 'describe', '--configuration', configuration, '--json'],
      { encoding: 'utf8', timeout: 10000 },
    );
    expect(described.stderr).toBe('');
    expect(described.status).toBe(0);
    const status = JSON.parse(described.stdout);
    expect(status.ready).toBe(true);
    expect(status.providerId).toBe('agent.handler.echo');
    return status;
  }
  private request(generation: string): AgentExecutionRequest {
    const { state: _state, ...authority } = this.binding;
    return {
      ...authority,
      protocol: 1,
      operation: 'composition-probe',
      executionId: 'execution:one',
      expectedGeneration: generation,
      handlerId: 'composition.probe',
      text: 'harmless fixture',
    };
  }
  private probe(configuration: string, request: AgentExecutionRequest): void {
    const result = spawnSync(
      'node',
      [resolve('dist/src/main.js'), 'probe', '--configuration', configuration, '--json'],
      { input: JSON.stringify(request), encoding: 'utf8', timeout: 10000 },
    );
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(this.expected(request));
  }
  private expected(request: AgentExecutionRequest): object {
    const { state: _state, ...authority } = this.binding;
    return {
      ...authority,
      protocol: 1,
      executionId: request.executionId,
      generation: request.expectedGeneration,
      handlerId: 'composition.probe',
      state: 'completed',
      output: 'harmless fixture',
      blockers: [],
      cleanup: 'disposed',
    };
  }
  private human(configuration: string, request: AgentExecutionRequest): void {
    const result = spawnSync(
      'node',
      [resolve('dist/src/main.js'), 'probe', '--configuration', configuration],
      {
        input: JSON.stringify({ ...request, executionId: 'execution:human' }),
        encoding: 'utf8',
        timeout: 10000,
      },
    );
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('completed');
    expect(result.stdout).toContain('harmless fixture');
  }
  safeArguments(): void {
    for (const args of [['--help'], ['--version']]) {
      const result = spawnSync('node', [resolve('dist/src/main.js'), ...args], {
        encoding: 'utf8',
        timeout: 10000,
      });
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout.length).toBeGreaterThan(0);
    }
    const invalid = spawnSync(
      'node',
      [resolve('dist/src/main.js'), 'probe', '--token', 'secret-output-canary'],
      { encoding: 'utf8', timeout: 10000 },
    );
    expect(invalid.status).toBe(2);
    expect(invalid.stderr + invalid.stdout).not.toContain('secret-output-canary');
  }
}
const suite = new AgentProgramAcceptance();
test(
  'acceptance: agent_program_uses_selected_registered_provider default native program',
  suite.selected.bind(suite),
);
test(
  'acceptance: Agent built help version and invalid arguments require no ambient authority',
  suite.safeArguments.bind(suite),
);
