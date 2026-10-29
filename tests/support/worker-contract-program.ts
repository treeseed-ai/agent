import assert from 'node:assert/strict';
import * as control from '@treeseed-cordis/sdk/provider-control';
import * as sdk from '@treeseed-cordis/sdk/portable';
class WorkerContractProgram {
  private readonly scope = {
    installationId: 'installation:fixture',
    serviceId: 'worker',
    providerGeneration: 'a'.repeat(64),
    serviceGeneration: 'b'.repeat(64),
  };
  run(): void {
    const schema = Reflect.get(sdk, 'SandboxControlSchemas');
    assert.equal(typeof schema, 'function', 'portable sandbox-control contracts must be selected');
    const binding = Reflect.get(sdk, 'SandboxControlBinding');
    this.capacityFamily();
    const request = this.request();
    const grant = this.grant();
    assert.equal(binding.assertRequest(request, grant, 1000).operation, 'ready');
    this.denials(binding, request, grant);
    assert.equal(
      schema.request.safeParse({ ...request, parameters: { command: 'arbitrary' } }).success,
      false,
    );
    assert.equal(sdk.PlatformOperations.all.length, 7);
    process.stdout.write('agent-worker-contract-ok\n');
  }
  private capacityFamily(): void {
    assert.equal(typeof Reflect.get(sdk, 'CapacityChannelSchemas'), 'function');
    assert.equal(typeof Reflect.get(sdk, 'CapacityChannelBinding'), 'function');
    const availability = Reflect.get(control, 'ProviderAvailabilitySchemas');
    assert.equal(typeof availability, 'function', 'availability schemas must be selected');
    assert.equal(Reflect.get(availability, 'version'), 'treeseed.provider-availability/v1');
    for (const method of ['createAvailabilitySession', 'refreshAvailabilitySession', 'closeAvailabilitySession'])
      assert.equal(typeof Reflect.get(control.ProviderProtocolClient.prototype, method), 'function');
  }
  private denials(binding: typeof sdk.SandboxControlBinding, request: object, grant: object): void {
    assert.throws(binding.assertRequest.bind(binding, request, grant, 2000), {
      message: 'SANDBOX_GRANT_EXPIRED',
    });
    assert.throws(
      binding.assertRequest.bind(
        binding,
        { ...request, scope: { ...this.scope, serviceId: 'foreign' } },
        grant,
        1000,
      ),
      { message: 'SANDBOX_SCOPE_MISMATCH' },
    );
  }
  private request(): object {
    return {
      schemaVersion: 'treeseed.sandbox-control/v1',
      requestId: 'request:fixture',
      scope: this.scope,
      operation: 'ready',
      parameters: {},
    };
  }
  private grant(): object {
    return {
      schemaVersion: 'treeseed.sandbox-grant/v1',
      id: 'grant:fixture',
      revision: 1,
      scope: this.scope,
      state: 'granted',
      expiresAtEpochMs: 2000,
      operations: ['ready'],
    };
  }
}
if (import.meta.main) new WorkerContractProgram().run();
