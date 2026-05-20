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
			agentSpecs: project.agentSpecs,
			workPolicy: project.workPolicy,
		})),
	};
}
