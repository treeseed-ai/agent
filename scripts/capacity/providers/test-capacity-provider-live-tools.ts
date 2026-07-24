if (process.env.TREESEED_AGENT_LIVE_TOOLS !== '1') {
	throw new Error('Set TREESEED_AGENT_LIVE_TOOLS=1 to run live capacity-provider tool acceptance.');
}

if (process.env.TREESEED_AGENT_LIVE_CODEX !== '1') {
	throw new Error('Set TREESEED_AGENT_LIVE_CODEX=1 to run the live Codex-backed capacity-provider tool acceptance.');
}

await import('../../agents/test-agent-tools-live.js');
