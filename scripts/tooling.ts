import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { SourcePolicy } from '@treeseed-cordis/sdk/source-policy';

/** Development-only owner gate; never a runtime composition or dependency resolver. */
class AgentTooling {
  static run(): void {
    const metadata = JSON.parse(readFileSync('package.json', 'utf8'));
    const expected = metadata.cordisCandidate.sdk.sha256;
    const actual = createHash('sha256').update(readFileSync('vendor/sdk.tgz')).digest('hex');
    if (actual !== expected) throw new Error('AGENT_SDK_ARCHIVE_CHANGED');
    new SourcePolicy().check(process.cwd(), process.argv[2] === 'build');
  }
}
if (import.meta.main) AgentTooling.run();
