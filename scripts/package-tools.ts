import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptRoot = dirname(fileURLToPath(import.meta.url));
const packageCandidate = resolve(scriptRoot, '..');

export const packageRoot = packageCandidate.endsWith('/dist')
	? resolve(packageCandidate, '..')
	: packageCandidate;
