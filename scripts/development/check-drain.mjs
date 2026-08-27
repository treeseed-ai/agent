import { existsSync, readFileSync } from 'node:fs';

const path = process.argv[2];
if (!path) throw new Error('Capacity state path is required.');
if (!existsSync(path)) process.exit(0);
const state = JSON.parse(readFileSync(path, 'utf8'));
if (!Array.isArray(state.claims) || !Array.isArray(state.connections) || !Array.isArray(state.events)) throw new Error('Provider capacity state is invalid.');
const active = state.claims.filter((claim) => ['ready', 'running', 'recovery'].includes(claim.status));
if (active.length) throw new Error(`Provider drain is blocked by ${active.length} active or unsettled assignment claim(s).`);
process.stdout.write(`${JSON.stringify({ drained: true, activeAssignments: 0, recoveryClaims: 0 })}\n`);
