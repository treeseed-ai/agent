import { expect, test } from 'bun:test';
import {
  ActivityPreparationFixture,
  ProfileObservations,
} from '../support/activity-preparation-program.js';
import { PoolBarrier } from '../support/warm-pool-program.js';

class ActivityPreparationBoundaries {
  async external(): Promise<void> {
    const fixture = new ActivityPreparationFixture();
    const resolver = await fixture.open();
    try {
      const result = await resolver.resolve(fixture.definition, fixture.signal.signal);
      expect(result[0]!.instance.typeId).toBe('external.health-probe');
      expect(result[0]!.instance.parameters).toEqual({ message: 'harmless fixture' });
      expect(ProfileObservations.calls).toEqual(['validate:profile:one']);
    } finally {
      await resolver.close();
    }
    expect(ProfileObservations.calls).toContain('profile-disposed');
  }
  async invalidParameters(): Promise<void> {
    const fixture = new ActivityPreparationFixture();
    fixture.definition.profiles[0]!.parameters.message = 42;
    const resolver = await fixture.open();
    try {
      await expect(resolver.resolve(fixture.definition, fixture.signal.signal)).rejects.toThrow(
        'ACTIVITY_PARAMETERS_INVALID',
      );
    } finally {
      await resolver.close();
    }
    expect(ProfileObservations.calls).not.toContain('HANDLER-MUST-NOT-EXECUTE');
  }
  async safeFailure(): Promise<void> {
    const fixture = new ActivityPreparationFixture();
    const resolver = await fixture.open('reject');
    try {
      await expect(resolver.resolve(fixture.definition, fixture.signal.signal)).rejects.toThrow(
        'ACTIVITY_PARAMETERS_INVALID',
      );
    } finally {
      await resolver.close();
    }
    expect(ProfileObservations.calls).toContain('profile-disposed');
  }
  async mutation(): Promise<void> {
    const fixture = new ActivityPreparationFixture();
    const resolver = await fixture.open('mutate');
    try {
      await expect(resolver.resolve(fixture.definition, fixture.signal.signal)).rejects.toThrow(
        'ACTIVITY_PARAMETERS_CHANGED',
      );
      expect(fixture.definition.profiles[0]!.parameters.message).toBe('harmless fixture');
    } finally {
      await resolver.close();
    }
  }
  async catalogueSnapshot(): Promise<void> {
    const fixture = new ActivityPreparationFixture();
    const resolver = await fixture.open();
    fixture.capability.provider.id = 'foreign.provider';
    try {
      const result = await resolver.resolve(fixture.definition, fixture.signal.signal);
      expect(result[0]!.capability.provider.id).toBe('fixture.profile');
    } finally {
      await resolver.close();
    }
  }
  async selectedIdentity(): Promise<void> {
    const fixture = new ActivityPreparationFixture();
    fixture.capability.provider.id = 'foreign.provider';
    const resolver = await fixture.open();
    try {
      await expect(resolver.resolve(fixture.definition, fixture.signal.signal)).rejects.toThrow(
        'ACTIVITY_PROVIDER_MISMATCH',
      );
      expect(ProfileObservations.calls).toEqual([]);
    } finally {
      await resolver.close();
    }
  }
  async selectedScope(): Promise<void> {
    const fixture = new ActivityPreparationFixture();
    fixture.capability.provider.scopeId = 'foreign.scope';
    const resolver = await fixture.open();
    try {
      await expect(resolver.resolve(fixture.definition, fixture.signal.signal)).rejects.toThrow(
        'ACTIVITY_PROVIDER_MISMATCH',
      );
      expect(ProfileObservations.calls).toEqual([]);
    } finally {
      await resolver.close();
    }
  }
  async missingHandler(): Promise<void> {
    const fixture = new ActivityPreparationFixture();
    fixture.definition.profiles[0]!.handler.providerId = 'missing.handler';
    const resolver = await fixture.open();
    try {
      await expect(resolver.resolve(fixture.definition, fixture.signal.signal)).rejects.toThrow(
        'ACTIVITY_PROVIDER_MISMATCH',
      );
      expect(ProfileObservations.calls).toEqual([]);
    } finally {
      await resolver.close();
    }
  }
  async cancelled(): Promise<void> {
    const fixture = new ActivityPreparationFixture();
    const resolver = await fixture.open();
    fixture.signal.abort();
    try {
      await expect(resolver.resolve(fixture.definition, fixture.signal.signal)).rejects.toThrow(
        'ACTIVITY_CANCELLED',
      );
      expect(ProfileObservations.calls).toEqual([]);
    } finally {
      await resolver.close();
    }
  }
  async drain(): Promise<void> {
    const fixture = new ActivityPreparationFixture();
    const resolver = await fixture.open('block');
    const barrier = new PoolBarrier();
    ProfileObservations.barrier = barrier;
    const result = resolver.resolve(fixture.definition, fixture.signal.signal);
    void result.catch(this.ignored.bind(this));
    await ProfileObservations.entered.promise;
    const closing = resolver.close();
    expect(ProfileObservations.calls).not.toContain('profile-disposed');
    barrier.release();
    await expect(result).rejects.toThrow('ACTIVITY_CANCELLED');
    await closing;
    expect(ProfileObservations.calls).toContain('profile-disposed');
    await expect(resolver.resolve(fixture.definition, fixture.signal.signal)).rejects.toThrow(
      'ACTIVITY_CLOSED',
    );
  }
  private ignored(_error: unknown): void {}
}
const suite = new ActivityPreparationBoundaries();
test(
  'integration: external activity type uses native selected profile and handler providers',
  suite.external.bind(suite),
);
test(
  'integration: executable profile validation rejects invalid parameters before handler dispatch',
  suite.invalidParameters.bind(suite),
);
test(
  'integration: private validator errors become fixed safe planning errors',
  suite.safeFailure.bind(suite),
);
test(
  'integration: profile validators cannot rewrite the accepted Agent definition',
  suite.mutation.bind(suite),
);
test(
  'integration: activity catalogue snapshots contain metadata rather than mutable selections',
  suite.catalogueSnapshot.bind(suite),
);
test(
  'integration: profile metadata cannot impersonate a different selected provider',
  suite.selectedIdentity.bind(suite),
);
test(
  'integration: profile metadata cannot cross the selected composition scope',
  suite.selectedScope.bind(suite),
);
test(
  'integration: unavailable selected handlers block before profile validators run',
  suite.missingHandler.bind(suite),
);
test(
  'integration: cancelled profile preparation performs no validator effects',
  suite.cancelled.bind(suite),
);
test(
  'integration: activity disposal drains validation before native provider cleanup',
  suite.drain.bind(suite),
);
