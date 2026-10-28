import { test, expect } from 'bun:test';
import { EnvironmentPreparationFixture, EnvironmentFixtureData as Data } from '../support/environment-preparation-program.js';

class EnvironmentPreparationBoundaries {
  private async blocked(mode: string, calls: string[], code = 'ENVIRONMENT_EXECUTION_FAILED'): Promise<void> {
    const fixture = new EnvironmentPreparationFixture();
    const scope = await fixture.open(mode);
    try {
      await expect(fixture.prepare(scope)).rejects.toMatchObject({ code, message: code });
      expect(Data.calls).toEqual(calls);
    } finally {
      await scope.dispose();
    }
  }
  async setupFailure(): Promise<void> {
    await this.blocked('fail-setup', ['setup']);
  }
  async verificationFailure(): Promise<void> {
    await this.blocked('fail-verification', ['setup', 'verification']);
  }
  async receipts(): Promise<void> {
    for (const mode of ['foreign', 'entry', 'exit', 'output', 'spoofed-error'])
      await this.blocked(mode, ['setup']);
  }
  async policyDenial(): Promise<void> {
    const fixture = new EnvironmentPreparationFixture();
    const scope = await fixture.open('success', 'deny');
    try {
      await expect(fixture.prepare(scope, { ...Data.environment, network: Data.online })).rejects.toMatchObject({ code: 'ENVIRONMENT_POLICY_DENIED' });
      expect(Data.calls).toEqual([]);
    } finally {
      await scope.dispose();
    }
  }
  async changedAuthority(): Promise<void> {
    const fixture = new EnvironmentPreparationFixture();
    const scope = await fixture.open('success', 'change');
    try {
      await expect(fixture.prepare(scope)).rejects.toMatchObject({ code: 'ENVIRONMENT_AUTHORITY_CHANGED' });
      expect(Data.calls).toEqual(['setup']);
    } finally {
      await scope.dispose();
    }
  }
  async cancelled(): Promise<void> {
    const fixture = new EnvironmentPreparationFixture();
    const scope = await fixture.open('cancel');
    try {
      await expect(fixture.prepare(scope, Data.environment, AbortSignal.timeout(20))).rejects.toMatchObject({ code: 'ENVIRONMENT_CANCELLED' });
      expect(Data.calls).toEqual(['setup']);
    } finally {
      await scope.dispose();
    }
  }
  async timeout(): Promise<void> {
    const fixture = new EnvironmentPreparationFixture();
    const scope = await fixture.open('cancel');
    const environment = { ...Data.environment, setup: { ...Data.environment.setup, deadlineMs: 20 } };
    try {
      await expect(fixture.prepare(scope, environment)).rejects.toMatchObject({ code: 'ENVIRONMENT_DEADLINE_EXCEEDED' });
      expect(Data.calls).toEqual(['setup']);
    } finally {
      await scope.dispose();
    }
  }
  async malformed(): Promise<void> {
    const fixture = new EnvironmentPreparationFixture();
    const scope = await fixture.open();
    try {
      await expect(fixture.prepare(scope, { ...Data.environment, credential: 'secret-output-canary' })).rejects.toMatchObject({ code: 'ENVIRONMENT_CONTRACT_INVALID', message: 'ENVIRONMENT_CONTRACT_INVALID' });
      expect(Data.calls).toEqual([]);
    } finally {
      await scope.dispose();
    }
  }
}
const suite = new EnvironmentPreparationBoundaries();
test('integration: guest setup failure prevents verification and exposes no provider diagnostic', suite.setupFailure.bind(suite));
test('integration: guest verification failure cannot publish preparation success', suite.verificationFailure.bind(suite));
test('integration: guest preparation rejects foreign mismatched and unbounded execution receipts', suite.receipts.bind(suite));
test('integration: host policy denial prevents any guest setup invocation', suite.policyDenial.bind(suite));
test('integration: changed authority after setup prevents verification', suite.changedAuthority.bind(suite));
test('integration: cancelled guest preparation awaits provider cancellation before disposal', suite.cancelled.bind(suite));
test('integration: guest entrypoint deadline prevents late preparation success', suite.timeout.bind(suite));
test('integration: malformed environment never reaches executable providers', suite.malformed.bind(suite));
