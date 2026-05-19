import { existsSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

export function findWorkspaceRoot(start = process.cwd()) {
	let current = resolve(start);
	for (;;) {
		if (existsSync(resolve(current, 'treeseed.site.yaml')) && existsSync(resolve(current, 'package.json'))) {
			return current;
		}
		const parent = dirname(current);
		if (parent === current) {
			return resolve(start);
		}
		current = parent;
	}
}

export function resolveWorkspaceReportPath(path: string) {
	if (isAbsolute(path)) {
		return path;
	}
	return resolve(findWorkspaceRoot(), path);
}
