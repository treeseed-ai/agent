/** Owner-build aliases only. Independent archive acceptance checks the emitted public declarations. */
declare module '@fixture/cordis-activity-profile' {
  export const ExternalActivityPackage: typeof import('./external-activity-plugin.js').ExternalActivityPackage;
  export const ExternalHealthProfilePlugin: typeof import('./external-activity-plugin.js').ExternalHealthProfilePlugin;
  export const ExternalHealthHandlerPlugin: typeof import('./external-activity-plugin.js').ExternalHealthHandlerPlugin;
}
