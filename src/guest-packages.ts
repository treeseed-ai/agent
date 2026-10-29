import { resolve } from 'node:path';
import { z } from 'zod';
import { CanonicalJson, CapacityContractError, type CapabilityToken } from '@treeseed-cordis/sdk';
import { InstalledProviderLoader, type ProviderRegistration } from '@treeseed-cordis/sdk/runtime';
import { GuestTokens } from './guest-providers.js';

/** Exact artifact admission only; native Cordis owns service instances and lifecycle. */
export class GuestPackages {
  private static readonly tokens: readonly CapabilityToken<object>[] = [
    GuestTokens.profile,
    GuestTokens.context,
    GuestTokens.handler,
    GuestTokens.tool,
    GuestTokens.reporting,
    GuestTokens.execution,
  ];
  static readonly reference = z.strictObject({
    capability: z.string().refine(this.known.bind(this)),
    file: z.string().min(1).max(4096).refine(this.absolute),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  });
  static readonly references = z.array(this.reference).max(this.tokens.length).refine(this.unique);
  private static absolute(file: string): boolean {
    return !file.includes('\0') && resolve(file) === file;
  }
  private static known(capability: string): boolean {
    for (const token of this.tokens) if (token.id === capability) return true;
    return false;
  }
  private static unique(references: { capability: string }[]): boolean {
    const selected = new Set<string>();
    for (const reference of references) selected.add(reference.capability);
    return selected.size === references.length;
  }
  static scopeId(scope: unknown): string {
    return 'capacity-guest:' + CanonicalJson.digest(scope);
  }
  static async load(scope: unknown, input: unknown): Promise<ProviderRegistration[]> {
    const references = this.references.safeParse(input);
    if (!references.success) throw new CapacityContractError('INVALID_CAPACITY_CONTRACT');
    const registrations: ProviderRegistration[] = [];
    try {
      for (const reference of references.data) {
        const token = this.token(reference.capability);
        registrations.push(
          await InstalledProviderLoader.load(
            reference.file,
            reference.sha256,
            token,
            'agent',
            this.scopeId(scope),
          ),
        );
      }
    } catch {
      throw new CapacityContractError('CAPACITY_CAPABILITY_DENIED');
    }
    return registrations;
  }
  private static token(capability: string): CapabilityToken<object> {
    for (const token of this.tokens) if (token.id === capability) return token;
    throw new CapacityContractError('CAPACITY_CAPABILITY_DENIED');
  }
}
