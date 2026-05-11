#!/usr/bin/env node

import { fileURLToPath } from 'node:url';
import { createRailwayTreeseedApiServer } from './railway.ts';

const currentFile = fileURLToPath(import.meta.url);
const entryFile = process.argv[1] ?? '';

if (entryFile === currentFile) {
	const instance = await createRailwayTreeseedApiServer();
	process.stdout.write(`Treeseed API listening on ${instance.url}\n`);
}
