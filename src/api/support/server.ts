#!/usr/bin/env node

import { isDirectEntrypoint } from '../../entrypoint.ts';
import { createRailwayApiServer } from '../hosting/railway.ts';

if (isDirectEntrypoint(import.meta.url, 'server.ts')) {
	const instance = await createRailwayApiServer();
	process.stdout.write(`Treeseed API listening on ${instance.url}\n`);
}
