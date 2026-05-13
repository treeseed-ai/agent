import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function isDirectEntrypoint(importMetaUrl: string, sourceFilename: string) {
	const currentFile = fileURLToPath(importMetaUrl);
	const entryFile = process.argv[1] ? resolve(process.argv[1]) : '';
	if (entryFile === currentFile) {
		return true;
	}
	return basename(currentFile).startsWith('.ts-run-')
		&& dirname(currentFile) === dirname(entryFile)
		&& basename(entryFile) === sourceFilename;
}
