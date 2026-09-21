import type { Handler } from './contracts.ts';

// The provider build may replace this module with a compiled project entry.
// Runtime never loads handler source or resolves modules from an assignment.
export const projectHandlers: readonly Handler[] = [];
