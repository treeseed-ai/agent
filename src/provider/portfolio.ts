import type { CapacityProviderPortfolioManifest } from '@treeseed/sdk/capacity-provider';
import { createProviderMarketClient } from './client.ts';
import type { ProviderRuntimeConfig } from './config.ts';

export async function fetchProviderPortfolio(config: ProviderRuntimeConfig): Promise<CapacityProviderPortfolioManifest> {
	return createProviderMarketClient(config).portfolio();
}

export function summarizeProviderPortfolio(portfolio: CapacityProviderPortfolioManifest) {
	return {
		team: portfolio.team,
		projectCount: portfolio.projects.length,
		projects: portfolio.projects.map((project) => ({
			id: project.id,
			slug: project.slug,
			name: project.name,
			repository: `${project.repository.owner}/${project.repository.name}`,
			defaultBranch: project.repository.defaultBranch,
			architecture: project.architecture
				? {
					topology: project.architecture.topology,
					sitePath: project.architecture.sitePath,
					contentPath: project.architecture.contentPath ?? null,
					contentRuntimeSource: project.architecture.contentRuntimeSource,
					localContentMaterialization: project.architecture.localContentMaterialization,
				}
				: null,
			workspaceAccess: project.architecture
				? {
					fullWorkspaceFiles: project.architecture.topology === 'single_repository_site',
					contentSource: project.architecture.contentRuntimeSource,
					localContentRequired: project.architecture.contentRuntimeSource === 'local_directory'
						|| project.architecture.localContentMaterialization === 'existing_path',
					pushCredentials: false,
				}
				: null,
			agentSpecs: project.agentSpecs,
			workPolicy: project.workPolicy,
		})),
	};
}
