import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const hardMaximum = 500;
const targetMaximum = 350;
const codeExtensions = /\.(?:astro|cjs|ex|exs|go|js|jsx|mjs|py|rs|svelte|ts|tsx|vue)$/u;
const excludedSegments = new Set([
	'.agent-worktrees', '.git', '.treeseed', '_build', 'build', 'coverage', 'deps', 'dist',
	'generated', 'migrations', 'node_modules', 'snapshots', 'target', 'vendor',
]);

function isExcluded(path: string) {
	const segments = path.split('/');
	return segments.some((segment) => excludedSegments.has(segment))
		|| segments.some((segment) => segment.startsWith('.treeseed-'))
		|| /(?:^|\.)generated\./u.test(segments.at(-1) ?? '')
		|| /-snapshots(?:\/|$)/u.test(path);
}

function gitFiles(args: string[]) {
	const result = spawnSync('git', ['ls-files', '-z', ...args], { encoding: 'utf8' });
	if (result.status !== 0) throw new Error(result.stderr || 'Unable to enumerate repository files.');
	return result.stdout.split('\0').filter(Boolean);
}

const codeFiles = [...new Set([
	...gitFiles([]),
	...gitFiles(['--others', '--exclude-standard']),
])].filter((path) => existsSync(path) && codeExtensions.test(path) && !isExcluded(path));

const overLimit: Array<{ path: string; lines: number }> = [];
const aboveTarget: Array<{ path: string; lines: number }> = [];
for (const path of codeFiles) {
	const lines = readFileSync(path, 'utf8').split(/\r?\n/u).length;
	if (lines > hardMaximum) overLimit.push({ path, lines });
	else if (lines > targetMaximum) aboveTarget.push({ path, lines });
}

aboveTarget.sort((left, right) => right.lines - left.lines);
overLimit.sort((left, right) => right.lines - left.lines);
if (aboveTarget.length > 0) console.warn(`File-length target: ${aboveTarget.length} handwritten file(s) are above ${targetMaximum} lines but within the hard limit.`);
if (overLimit.length > 0) {
	console.error(`File-length policy failed: ${overLimit.length} handwritten file(s) exceed ${hardMaximum} lines:`);
	for (const entry of overLimit) console.error(`- ${entry.lines} ${entry.path}`);
	process.exit(1);
}
console.log(`File-length policy passed: no handwritten code exceeds ${hardMaximum} lines.`);
