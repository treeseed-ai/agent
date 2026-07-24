import type { AgentSdk, RemoteSdkOperationRequest } from '@treeseed/sdk';
import { AgentSdk as AgentSdkClass, executeSdkOperation, findSdkOperation, listSdkOperationNames } from '@treeseed/sdk';
import type { ApiConfig } from '../types.ts';

export {
	executeSdkOperation,
	findSdkOperation,
	listSdkOperationNames,
};

export function resolveSdkInstance(
	sharedSdk: AgentSdk | undefined,
	config: ApiConfig,
	request: RemoteSdkOperationRequest,
) {
	if (!request.repoRoot || request.repoRoot === config.repoRoot) {
		return sharedSdk ?? AgentSdkClass.createLocal({ repoRoot: config.repoRoot });
	}
	return AgentSdkClass.createLocal({ repoRoot: request.repoRoot });
}
