import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

function repositoryFiles() {
	const result = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' });
	if (result.status !== 0) throw new Error(result.stderr || 'Unable to enumerate repository files.');
	return result.stdout.split('\0').filter(Boolean).filter(existsSync);
}

const violations: string[] = [];
for (const path of repositoryFiles()) {
	const basename = path.split('/').at(-1) ?? path;
	if (/^(?:chunk|module|part|section|segment)-\d+\./u.test(basename)) {
		violations.push(`${path}: generic numbered partition`);
	}
	if (/-\d{1,2}\.(?:scenarios|spec|test)\.[^.]+$/u.test(basename)) {
		violations.push(`${path}: ordinal test or scenario suffix`);
	}
	if (path.startsWith('src/api/routes/') && basename.includes('-through-')) {
		violations.push(`${path}: route-order range name`);
	}
	if (/split-(?:class-methods|large-tests|module-declarations)\.[^.]+$/u.test(basename)) {
		violations.push(`${path}: mechanical split script`);
	}
	if (path.startsWith('scripts/') && /\.(?:spec|test)\.[^.]+$/u.test(basename)) {
		violations.push(`${path}: test belongs under tests/`);
	}
	if (/\.(?:js|jsx|ts|tsx)$/u.test(path)) {
		const source = readFileSync(path, 'utf8');
		if (/\b(?:CLI_COMMAND_OVERLAYS|CLI_ONLY_OPERATION_SPECS|MODULE|PART)_\d+\b/u.test(source)) {
			violations.push(`${path}: ordinal partition symbol`);
		}
	}
}

if (existsSync('test') && existsSync('tests')) {
	violations.push('test and tests: duplicate TypeScript test roots');
}

if (violations.length > 0) {
	console.error('File architecture policy failed:');
	for (const violation of violations) console.error(`- ${violation}`);
	process.exit(1);
}

console.log('File architecture policy passed: filenames and test roots express functional ownership.');
