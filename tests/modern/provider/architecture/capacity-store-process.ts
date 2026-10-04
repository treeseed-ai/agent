import { ProviderLocalCapacityStore } from '../../../../src/provider/capacity/capacity-core/local-capacity-store.ts';

// Native child fixture calls the SAME owning store. No manager, executor,
// alternative arbitration implementation, live data directory or credentials.
const [directory, action, identity] = process.argv.slice(2);
if (!directory || !identity) throw new Error('Exact isolated capacity fixture arguments required');
const store = new ProviderLocalCapacityStore(directory);
if (action === 'claim') process.stdout.write(JSON.stringify(await store.claim({ connectionId: identity, globalLimit: 2, connectionLimit: 1 })));
else if (action === 'dispatch') process.stdout.write(JSON.stringify(await store.claimDispatch(identity)));
else if (action === 'finish') {
	await store.finishActiveExecution(identity);
	const claim = (await store.claimsForRecovery()).find(value => value.id === identity);
	if (!claim?.activeStartedAt || !claim.activeFinishedAt) throw new Error('Original native execution clocks required');
	process.stdout.write(JSON.stringify({ activeStartedAt: claim.activeStartedAt, activeFinishedAt: claim.activeFinishedAt }));
} else if (action === 'observe') {
	const scope: unknown = JSON.parse(identity);
	if (!Array.isArray(scope) || scope.length !== 2 || typeof scope[0] !== 'string' || !scope[0]
		|| typeof scope[1] !== 'string' || !scope[1]) throw new Error('Original model and capability required');
	process.stdout.write(JSON.stringify(await store.activeTimeObservation(scope[0], [scope[1]])));
} else if (action === 'finalize') process.stdout.write(JSON.stringify(await store.finalize(identity, 'native-accounted-terminal-confirmed')));
else throw new Error('Unknown capacity fixture operation');
