import { AgentPrivateFile } from './authority.js';
import { CapacityWorkerService } from './worker-service.js';
import { CapacityServiceProgram } from './capacity-program.js';
/** Worker startup owns configuration; the shared channel preserves framing and native drain. */
class WorkerProgram {
  static async main(): Promise<void> {
    try {
      if (process.argv.length !== 4 || process.argv[2] !== '--config') throw new Error();
      const worker = await CapacityWorkerService.start(AgentPrivateFile.read(process.argv[3]!));
      await CapacityServiceProgram.serve(worker);
    } catch {
      process.stderr.write('INVALID_CAPACITY_CONTRACT\n');
      process.exitCode = 2;
    }
  }
}
if (import.meta.main) await WorkerProgram.main();
