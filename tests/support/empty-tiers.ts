import { mkdirSync } from 'node:fs';

/** Development-only setup: these tiers are honestly empty in the policy-only baseline. */
class EmptyTestTiers {
  static prepare(): void {
    for (const tier of ['regression', 'integration', 'unit']) {
      mkdirSync('tests/' + tier, { recursive: true });
    }
  }
}

if (import.meta.main) EmptyTestTiers.prepare();
