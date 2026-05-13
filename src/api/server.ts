#!/usr/bin/env node

import { isDirectEntrypoint } from '../entrypoint.ts';
import { createRailwayTreeseedApiServer } from './railway.ts';

if (isDirectEntrypoint(import.meta.url, 'server.ts')) {
	const instance = await createRailwayTreeseedApiServer();
	process.stdout.write(`Treeseed API listening on ${instance.url}\n`);
}
