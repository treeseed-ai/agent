import assert from 'node:assert/strict';
import * as authority from '@treeseed-cordis/agent/authority';
import * as sdk from '@treeseed-cordis/sdk';
import {
  mkdtempSync,
  writeFileSync,
  existsSync,
  chmodSync,
  unlinkSync,
  symlinkSync,
  linkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
interface AssignmentReader {
  readonly generation: string;
  observe(signal: AbortSignal): Promise<sdk.CapacityDispatch>;
  close(): Promise<void>;
}
interface AssignmentConstructor {
  start(input: unknown): Promise<AssignmentReader>;
}
/** Data-only assignment fixture; no live enrollment, worker or sandbox claim. */
class AssignmentFixture {
  readonly directory = mkdtempSync(join(tmpdir(), 'capacity-assignment-'));
  readonly file = join(this.directory, 'assignment.json');
  private static readonly data = {
    schemaVersion: 'treeseed.capacity-dispatch/v1',
    reservationId: 'fixture.reservation',
    requestId: 'fixture.request',
    lease: {
      schemaVersion: 'treeseed.capacity-lease/v1',
      operation: 'capacity-probe',
      id: 'fixture.lease',
      assignmentId: 'fixture.assignment',
      sandboxId: 'fixture.sandbox',
      scope: {
        installationId: 'fixture.installation',
        installationDirectory: '/fixture/capacity',
        capacityProviderId: 'fixture.capacity',
        project: 'fixture.project',
        platformProfile: 'default',
        workerId: 'fixture.worker',
      },
      authority: {
        issuer: 'https://identity.example.invalid/realms/fixture',
        subject: 'fixture.subject',
        teamId: 'fixture.team',
        providerId: 'fixture.capacity',
        credentialId: 'fixture.credential',
        credentialRevision: 1,
        grantId: 'fixture.grant',
        grantRevision: 1,
        capabilities: ['agent.probe'],
        state: 'granted',
        expiresAtEpochMs: 5000,
      },
      generations: {
        manager: {
          compositionGeneration: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          processGeneration: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        },
        worker: {
          compositionGeneration: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          processGeneration: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        },
        runner: {
          compositionGeneration: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          processGeneration: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        },
        pool: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        sandbox: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        environment: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      },
      compatibilityDigest: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      fence: 1,
      expiresAtEpochMs: 4000,
    },
    definition: {
      schemaVersion: 'treeseed.agent-definition/v1',
      id: 'fixture.agent',
      revision: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      profiles: [
        {
          id: 'fixture.check',
          typeId: 'external.health-probe',
          capabilityRevision: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          handler: {
            providerId: 'fixture.handler',
            capability: 'agent.handler.probe',
            contractVersion: '1.0.0',
          },
          environmentId: 'fixture.environment',
          parameters: {
            message: 'harmless fixture',
          },
          dependsOn: [],
        },
      ],
    },
    profileId: 'fixture.check',
    environment: {
      schemaVersion: 'treeseed.agent-environment/v1',
      id: 'fixture.environment',
      revision: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      artifact: {
        package: '@fixture/environment',
        version: '1.0.0',
        integrity: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      },
      image: {
        reference:
          'fixture/base@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        manifestDigest: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        os: 'linux',
        architecture: 'amd64',
      },
      setup: {
        file: {
          path: 'dist/setup',
          sha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          size: 1,
        },
        arguments: [],
        deadlineMs: 30000,
        outputLimitBytes: 4096,
      },
      verification: {
        file: {
          path: 'dist/setup',
          sha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          size: 1,
        },
        arguments: [],
        deadlineMs: 30000,
        outputLimitBytes: 4096,
      },
    },
    input: 'harmless fixture',
  };
  record(): sdk.CapacityDispatch {
    const record = sdk.CapacityProtocolSchemas.dispatch.parse(
      structuredClone(AssignmentFixture.data),
    );
    record.lease.scope.installationDirectory = this.directory;
    record.lease.expiresAtEpochMs = Date.now() + 30000;
    record.lease.authority.expiresAtEpochMs = Date.now() + 60000;
    return record;
  }
  write(record: unknown): void {
    writeFileSync(this.file, JSON.stringify(record), { mode: 0o600 });
  }
}
class CapacityAssignmentProgram {
  private readonly fixture = new AssignmentFixture();
  private readonly signal = new AbortController().signal;
  private api(): AssignmentConstructor {
    const api = Reflect.get(authority, 'CapacityAssignmentFile');
    assert.equal(typeof api, 'function', 'default native capacity assignment reader must exist');
    assert.equal(typeof Reflect.get(sdk, 'CapacityChannelSchemas'), 'function');
    return api;
  }
  async run(): Promise<void> {
    const record = this.fixture.record();
    const reader = await this.api().start({ file: this.fixture.file, scope: record.lease.scope });
    try {
      if (process.argv[2] === '--deny') await this.denied(reader, record);
      else await this.read(reader, record);
    } finally {
      await reader.close();
    }
    await assert.rejects(reader.observe(this.signal), { message: 'CAPACITY_TARGET_UNREADY' });
    process.stdout.write(
      'capacity-assignment-' + (process.argv[2] === '--deny' ? 'deny' : 'read') + '-ok\n',
    );
  }
  private async read(reader: AssignmentReader, record: sdk.CapacityDispatch): Promise<void> {
    assert.match(reader.generation, /^[a-f0-9]{64}$/);
    await assert.rejects(reader.observe(this.signal), { message: 'CAPACITY_TARGET_UNREADY' });
    assert.equal(existsSync(this.fixture.file), false);
    this.fixture.write(record);
    assert.deepEqual(await reader.observe(this.signal), record);
    record.input = 'changed harmless fixture';
    this.fixture.write(record);
    assert.deepEqual(await reader.observe(this.signal), record);
  }
  private async denied(reader: AssignmentReader, record: sdk.CapacityDispatch): Promise<void> {
    this.fixture.write({ ...record, lease: { ...record.lease, expiresAtEpochMs: Date.now() - 1 } });
    await assert.rejects(reader.observe(this.signal), { message: 'CAPACITY_LEASE_EXPIRED' });
    const foreign = structuredClone(record);
    foreign.lease.scope.project = 'foreign-project';
    this.fixture.write(foreign);
    await assert.rejects(reader.observe(this.signal), { message: 'CAPACITY_SCOPE_MISMATCH' });
    this.fixture.write({ secret: 'assignment-output-canary' });
    await assert.rejects(reader.observe(this.signal), { message: 'INVALID_CAPACITY_CONTRACT' });
    await this.permissions(reader, record);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(reader.observe(controller.signal), { message: 'CAPACITY_CANCELLED' });
  }
  private async permissions(reader: AssignmentReader, record: sdk.CapacityDispatch): Promise<void> {
    this.fixture.write(record);
    chmodSync(this.fixture.file, 0o644);
    await assert.rejects(reader.observe(this.signal), { message: 'CAPACITY_TARGET_UNREADY' });
    unlinkSync(this.fixture.file);
    const target = join(this.fixture.directory, 'retained.json');
    writeFileSync(target, JSON.stringify(record), { mode: 0o600 });
    symlinkSync(target, this.fixture.file);
    await assert.rejects(reader.observe(this.signal), { message: 'CAPACITY_TARGET_UNREADY' });
    unlinkSync(this.fixture.file);
    linkSync(target, this.fixture.file);
    await assert.rejects(reader.observe(this.signal), { message: 'CAPACITY_TARGET_UNREADY' });
    unlinkSync(this.fixture.file);
  }
}
if (import.meta.main) await new CapacityAssignmentProgram().run();
