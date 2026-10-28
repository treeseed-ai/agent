/** Public immutable data; never reads installation files or owns service instances. */
export class AgentPackageIdentity {
  static readonly version = '0.0.0-cordis.17';
  static readonly artifact = '@treeseed-cordis/agent@' + this.version;
}
