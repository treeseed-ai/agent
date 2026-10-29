import { AgentPrivateFile } from './authority.js';
import { CapacityServiceProgram } from './capacity-program.js';
import { CapacityManagerService } from './manager-service.js';
class ManagerProgram {
  static async main(): Promise<void> {
    try {
      if (process.argv.length !== 4 || process.argv[2] !== '--config') throw new Error();
      const manager = await CapacityManagerService.start(AgentPrivateFile.read(process.argv[3]!));
      await CapacityServiceProgram.serve(manager);
    } catch {
      process.stderr.write('INVALID_CAPACITY_CONTRACT\n');
      process.exitCode = 2;
    }
  }
}
if (import.meta.main) await ManagerProgram.main();
