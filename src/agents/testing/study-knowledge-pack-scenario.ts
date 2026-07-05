import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path, { dirname, resolve } from 'node:path';
import { exportBookPackage } from '@treeseed/sdk/platform/book-export';
import { checkCodexProviderReadiness, type CodexProviderReadiness } from '../adapters/codex-readiness.ts';
import { runCodexSubscriptionTask } from '../adapters/execution-codex.ts';

const DEFAULT_WORKDAY_COUNT = 10;
const DEFAULT_DAILY_ASSUMED_MINUTES = 480;
const DEFAULT_PROVIDER_CAPACITY_SHARE = 0.3;

type CoursePlan = {
	slug: string;
	title: string;
	objective: string;
	agentArchitecture: string[];
	workdays: Array<{
		topic: string;
		proposal: string;
		decision: string;
		synthesis: string;
		studyPrompt: string;
	}>;
};

export interface StudyKnowledgePackScenarioOptions {
	repoRoot?: string;
	outputRoot?: string;
	workdayCount?: number;
	now?: Date;
	codexMode?: 'required' | 'skip';
}

export interface StudyKnowledgePackProjectResult {
	projectId: string;
	projectRoot: string;
	title: string;
	coreObjective: string;
	allocationShare: number;
	dailyMinutes: number;
	workdayCount: number;
	proposalCount: number;
	decisionCount: number;
	communicationMessageCount: number;
	bookPackage: {
		markdownPath: string;
		indexPath: string;
		sourceFileCount: number;
	};
	liveCodex: {
		status: 'completed' | 'failed' | 'waiting' | 'skipped';
		threadId: string | null;
		summary: string;
		finalResponse: string;
	};
	readablePackPath: string;
}

export interface StudyKnowledgePackScenarioResult {
	ok: boolean;
	generatedAt: string;
	student: {
		id: string;
		name: string;
		role: string;
	};
	team: {
		id: string;
		name: string;
	};
	capacityProvider: {
		id: string;
		kind: 'codex_subscription';
		dailyAssumedMinutes: number;
		allocatedShare: number;
		allocatedMinutesPerDay: number;
		projectMinutesPerDay: number;
		capabilities: string[];
	};
	codexReadiness: CodexProviderReadiness;
	allocation: {
		totalProjects: number;
		projectShare: number;
	};
	projects: StudyKnowledgePackProjectResult[];
	portfolioPath: string;
	summaryPath: string;
}

function discoverRepoRoot(start = process.cwd()) {
	let current = resolve(start);
	for (let index = 0; index < 8; index += 1) {
		if (existsSync(resolve(current, 'starters/research/template')) && existsSync(resolve(current, 'packages/agent'))) {
			return current;
		}
		if (existsSync(resolve(current, 'package.json')) && existsSync(resolve(current, 'src/agents/testing/study-knowledge-pack-scenario.ts'))) {
			return current;
		}
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
	throw new Error(`Unable to locate Treeseed repository root from ${start}`);
}

function yamlString(value: string) {
	return JSON.stringify(value);
}

function mdFrontmatter(fields: Record<string, unknown>) {
	const lines = ['---'];
	for (const [key, value] of Object.entries(fields)) {
		if (Array.isArray(value)) {
			lines.push(`${key}:`);
			for (const entry of value) lines.push(`  - ${yamlString(String(entry))}`);
		} else if (typeof value === 'number' || typeof value === 'boolean') {
			lines.push(`${key}: ${value}`);
		} else {
			lines.push(`${key}: ${yamlString(String(value ?? ''))}`);
		}
	}
	lines.push('---', '');
	return lines.join('\n');
}

function writeText(filePath: string, content: string) {
	mkdirSync(dirname(filePath), { recursive: true });
	writeFileSync(filePath, content.endsWith('\n') ? content : `${content}\n`, 'utf8');
}

function replaceInFile(filePath: string, replacements: Record<string, string>) {
	let content = readFileSync(filePath, 'utf8');
	for (const [token, value] of Object.entries(replacements)) {
		content = content.replaceAll(token, value);
	}
	writeFileSync(filePath, content, 'utf8');
}

function ensureEmptyDir(dirPath: string) {
	rmSync(dirPath, { recursive: true, force: true });
	mkdirSync(dirPath, { recursive: true });
}

function courses(): CoursePlan[] {
	return [
		{
			slug: 'psychology-101',
			title: 'Psychology 101',
			objective: 'VERY IMPORTANT: build an exam-ready knowledge pack that explains introductory psychology concepts, research methods, major domains of behavior, and practical study prompts with enough clarity for a first-year university student to review and apply them.',
			agentArchitecture: ['architect', 'researcher', 'technical-writer', 'reviewer', 'reporter'],
			workdays: [
				{
					topic: 'orientation and scientific method',
					proposal: 'Map the course around behavior, mental processes, research design, ethics, and evidence quality before drafting topical chapters.',
					decision: 'Approved. The student vote requires every later section to separate claim, evidence, and study implication.',
					synthesis: 'Psychology becomes durable when concepts are tied to operational definitions, falsifiable hypotheses, valid measures, and ethical treatment of participants.',
					studyPrompt: 'Explain why a correlation cannot establish causation and name a design that can test causal influence.',
				},
				{
					topic: 'biological bases of behavior',
					proposal: 'Create a compact map of neurons, neurotransmitters, endocrine signaling, brain localization, and plasticity.',
					decision: 'Approved with an added requirement to connect biology to behavior without reducing behavior to biology alone.',
					synthesis: 'Neural communication, hormones, and brain systems shape attention, emotion, learning, and movement, while experience continues to reorganize pathways through plasticity.',
					studyPrompt: 'Compare a neurotransmitter effect with a hormone effect using timing and target scope.',
				},
				{
					topic: 'sensation and perception',
					proposal: 'Use examples to distinguish sensory transduction from perceptual interpretation.',
					decision: 'Approved. The pack should include bottom-up and top-down processing as a recurring contrast.',
					synthesis: 'Sensation converts physical energy into neural signals; perception organizes those signals using context, expectations, attention, and prior knowledge.',
					studyPrompt: 'Give one illusion and identify the top-down assumption it reveals.',
				},
				{
					topic: 'learning',
					proposal: 'Summarize classical conditioning, operant conditioning, observational learning, and reinforcement schedules.',
					decision: 'Approved with a note to include classroom and habit examples.',
					synthesis: 'Learning theories explain how associations form, consequences alter behavior, and models transmit behavior through attention, retention, reproduction, and motivation.',
					studyPrompt: 'Design a reinforcement plan for building a study habit and explain why it should fade over time.',
				},
				{
					topic: 'memory',
					proposal: 'Build a memory chapter around encoding, storage, retrieval, forgetting, and study strategies.',
					decision: 'Approved. The student vote prioritizes retrieval practice and spaced repetition as actionable outputs.',
					synthesis: 'Memory is reconstructive: effective studying strengthens retrieval routes, uses spacing, elaboration, and cues, and treats forgetting as a signal to practice recall.',
					studyPrompt: 'Turn one chapter heading into three retrieval-practice questions.',
				},
				{
					topic: 'cognition and intelligence',
					proposal: 'Connect concepts, problem solving, bias, language, and intelligence measurement.',
					decision: 'Approved with caution to discuss measurement limits and cultural context.',
					synthesis: 'Thinking uses mental shortcuts that can improve speed but create bias; intelligence tests measure useful samples of performance but never exhaust human ability.',
					studyPrompt: 'Identify availability heuristic, confirmation bias, and framing in a single everyday choice.',
				},
				{
					topic: 'development',
					proposal: 'Organize development around nature and nurture, attachment, cognitive stages, identity, and lifespan change.',
					decision: 'Approved. The pack should avoid making stage theories sound mechanically universal.',
					synthesis: 'Development is continuous and staged in different respects, shaped by biology, caregivers, culture, peers, and historical context across the lifespan.',
					studyPrompt: 'Compare Piaget, attachment theory, and Erikson using one child-development example.',
				},
				{
					topic: 'social psychology',
					proposal: 'Prioritize attribution, conformity, obedience, group influence, prejudice, and helping.',
					decision: 'Approved. Include communication advice for study groups and classroom collaboration.',
					synthesis: 'Social contexts powerfully alter judgment and behavior; norms, roles, authority, identity, and group pressure can support cooperation or distort responsibility.',
					studyPrompt: 'Explain a bystander-effect scenario and name two interventions that increase helping.',
				},
				{
					topic: 'psychological disorders',
					proposal: 'Frame disorders through distress, dysfunction, deviance, diagnosis, and biopsychosocial explanation.',
					decision: 'Approved with a strong anti-stigma requirement.',
					synthesis: 'Diagnostic categories help organize care, but disorders are best understood through interacting biological vulnerability, psychological patterns, and social context.',
					studyPrompt: 'Use the biopsychosocial model to explain one anxiety disorder without blaming the person.',
				},
				{
					topic: 'therapy and review synthesis',
					proposal: 'Close with major therapy approaches, evidence-based care, prevention, and final exam review cards.',
					decision: 'Approved. Export the knowledge pack after converting all chapters into review prompts.',
					synthesis: 'Psychological treatment works through different mechanisms: insight, behavior change, cognitive restructuring, relationship, medication, prevention, and support systems.',
					studyPrompt: 'Match CBT, exposure therapy, psychoeducation, and medication to the problem each best addresses.',
				},
			],
		},
		{
			slug: 'macro-economics-301',
			title: 'Macro Economics 301',
			objective: 'VERY IMPORTANT: build a university-level macroeconomics knowledge pack that connects national income accounting, growth, inflation, unemployment, fiscal policy, monetary policy, open-economy dynamics, and policy tradeoffs into a usable study and analysis guide.',
			agentArchitecture: ['architect', 'researcher', 'technical-writer', 'reviewer', 'reporter'],
			workdays: [
				{
					topic: 'measurement and GDP',
					proposal: 'Start with GDP, income, expenditure, real versus nominal values, and the limits of national accounts.',
					decision: 'Approved. Every model must say what it measures and what it leaves out.',
					synthesis: 'GDP measures market production within a period, but welfare analysis also needs distribution, unpaid work, environmental costs, leisure, and non-market value.',
					studyPrompt: 'Explain the expenditure approach to GDP and give one welfare limitation.',
				},
				{
					topic: 'long-run growth',
					proposal: 'Build the growth chapter around productivity, capital, labor, technology, institutions, and convergence.',
					decision: 'Approved with a request to distinguish level effects from growth-rate effects.',
					synthesis: 'Sustained growth depends on productivity improvement from technology, human capital, physical capital, institutions, and innovation incentives.',
					studyPrompt: 'Describe how a one-time capital increase differs from sustained technological progress.',
				},
				{
					topic: 'unemployment and inflation',
					proposal: 'Connect labor-market categories, price indexes, inflation costs, and expectation formation.',
					decision: 'Approved. Add examples for frictional, structural, and cyclical unemployment.',
					synthesis: 'Unemployment and inflation are measured constructs with policy relevance; expectations link wage setting, price setting, and central-bank credibility.',
					studyPrompt: 'Classify an unemployed worker in three scenarios and explain the policy implication of each.',
				},
				{
					topic: 'aggregate demand and aggregate supply',
					proposal: 'Use AD-AS as the course backbone for short-run shocks and long-run adjustment.',
					decision: 'Approved with a requirement to mark short-run versus long-run curves clearly.',
					synthesis: 'AD-AS links spending, production, prices, and output gaps; demand shocks move output and prices together, while supply shocks create harsher inflation-output tradeoffs.',
					studyPrompt: 'Draw the effect of an oil-price shock and explain why policy response is difficult.',
				},
				{
					topic: 'fiscal policy',
					proposal: 'Summarize automatic stabilizers, discretionary spending, taxes, multipliers, deficits, and debt sustainability.',
					decision: 'Approved. Include timing lags and political constraints.',
					synthesis: 'Fiscal policy can stabilize demand and fund public investment, but impact depends on multipliers, debt capacity, timing, crowding out, and institutional credibility.',
					studyPrompt: 'When would a tax cut have a smaller multiplier than government purchases?',
				},
				{
					topic: 'money and banking',
					proposal: 'Create a money chapter covering banking, reserves, deposits, interest rates, and financial intermediation.',
					decision: 'Approved with an added note about bank runs and lender-of-last-resort roles.',
					synthesis: 'Banks transform liquidity and maturity, expanding credit while creating fragility that requires regulation, deposit insurance, and central-bank backstops.',
					studyPrompt: 'Explain how a bank can be solvent but illiquid.',
				},
				{
					topic: 'monetary policy',
					proposal: 'Connect policy rates, inflation targets, transmission channels, central-bank independence, and zero lower bound tools.',
					decision: 'Approved. Emphasize expectations and credibility.',
					synthesis: 'Monetary policy works through interest rates, asset prices, exchange rates, credit, and expectations; credibility shapes how quickly inflation and output respond.',
					studyPrompt: 'Trace how a rate increase can lower inflation through two channels.',
				},
				{
					topic: 'open economy',
					proposal: 'Add balance of payments, exchange rates, trade balances, capital flows, and policy constraints.',
					decision: 'Approved with a requirement for exchange-rate regime comparison.',
					synthesis: 'Open economies face linkages between domestic policy, capital mobility, exchange rates, trade flows, and external balances, making policy coordination more complex.',
					studyPrompt: 'Compare fiscal expansion under fixed and floating exchange rates.',
				},
				{
					topic: 'stabilization and policy rules',
					proposal: 'Compare discretionary stabilization with rules, automatic triggers, and credibility commitments.',
					decision: 'Approved. Add a Taylor-rule style intuition without excessive algebra.',
					synthesis: 'Policy rules reduce uncertainty and time-inconsistency problems, while discretion can respond to unusual shocks that rules did not anticipate.',
					studyPrompt: 'Explain why central banks care about both inflation gaps and output gaps.',
				},
				{
					topic: 'case synthesis and exam pack',
					proposal: 'Close with an applied shock-analysis checklist and export-ready study cards.',
					decision: 'Approved. The student vote requests reusable templates for analyzing any macro news article.',
					synthesis: 'A strong macro analysis identifies the shock, affected market, model horizon, policy levers, distributional effects, and evidence that would confirm or falsify the story.',
					studyPrompt: 'Use the shock checklist on a recession headline and separate data from interpretation.',
				},
			],
		},
		{
			slug: 'art-history',
			title: 'Art History',
			objective: 'VERY IMPORTANT: build a readable art history knowledge pack that teaches visual analysis, historical context, major periods and movements, materials, patronage, museums, and comparison strategies for a university study group.',
			agentArchitecture: ['architect', 'researcher', 'technical-writer', 'reviewer', 'reporter'],
			workdays: [
				{
					topic: 'visual analysis foundations',
					proposal: 'Begin with form, composition, scale, color, line, texture, iconography, and viewer position.',
					decision: 'Approved. Every later period must include a repeatable looking checklist.',
					synthesis: 'Art history begins with disciplined looking: describe what is visible, infer how formal choices guide attention, then connect those choices to context.',
					studyPrompt: 'Analyze one artwork using line, composition, color, and scale before naming the period.',
				},
				{
					topic: 'ancient and classical worlds',
					proposal: 'Map Mesopotamian, Egyptian, Greek, and Roman art around power, ritual, idealization, and public memory.',
					decision: 'Approved with comparisons between divine authority and civic identity.',
					synthesis: 'Ancient art often stabilizes authority through monumentality, durable materials, ideal bodies, inscriptions, and controlled public display.',
					studyPrompt: 'Compare an Egyptian statue and a Greek sculpture using body, patron, and purpose.',
				},
				{
					topic: 'medieval, Byzantine, and Islamic contexts',
					proposal: 'Frame the period through sacred space, manuscript culture, icon debates, ornament, and architecture.',
					decision: 'Approved. Include caution against treating medieval art as merely pre-Renaissance.',
					synthesis: 'Medieval and related sacred traditions use image, material, text, light, and ornament to organize devotion, authority, memory, and communal identity.',
					studyPrompt: 'Explain how material and light shape meaning in a sacred space.',
				},
				{
					topic: 'Renaissance',
					proposal: 'Build a Renaissance chapter around humanism, perspective, patronage, anatomy, antiquity, and workshops.',
					decision: 'Approved with Northern and Italian comparisons.',
					synthesis: 'Renaissance art remakes classical inheritance through perspective, anatomy, patronage, and humanist learning while differing across local markets and devotional needs.',
					studyPrompt: 'Compare linear perspective with symbolic scale in terms of viewer experience.',
				},
				{
					topic: 'Baroque and Rococo',
					proposal: 'Contrast dramatic Baroque movement and persuasion with Rococo intimacy and ornament.',
					decision: 'Approved. Include church, court, and domestic patron contexts.',
					synthesis: 'Baroque art mobilizes theatrical space, light, emotion, and motion for persuasion; Rococo often turns toward refined leisure, surface, and private sociability.',
					studyPrompt: 'Identify how light and movement create emotional force in a Baroque work.',
				},
				{
					topic: 'modernism',
					proposal: 'Create a modernism map from realism and impressionism through abstraction and avant-garde critique.',
					decision: 'Approved. The study group asks for movement-by-movement comparison cards.',
					synthesis: 'Modernism repeatedly challenges academic norms through new subjects, brushwork, materials, abstraction, fragmentation, and claims about modern life.',
					studyPrompt: 'Compare Impressionism and Cubism using time, vision, and surface.',
				},
				{
					topic: 'global and cross-cultural art histories',
					proposal: 'Add a chapter that resists a single Western timeline and foregrounds exchange, empire, and local meaning.',
					decision: 'Approved with a requirement to name context before comparison.',
					synthesis: 'Global art histories ask who made the work, for whom, under what exchange networks, and how categories change across culture, empire, diaspora, and market.',
					studyPrompt: 'Write a comparison that does not make one tradition the default standard.',
				},
				{
					topic: 'photography, film, and new media',
					proposal: 'Treat mechanical and digital media as art-historical shifts in reproduction, authorship, evidence, and spectatorship.',
					decision: 'Approved. Include questions of truth and manipulation.',
					synthesis: 'New media transform art by changing how images circulate, who can make them, what counts as originality, and how viewers interpret evidence.',
					studyPrompt: 'Explain how photography can be both documentary evidence and constructed image.',
				},
				{
					topic: 'museums, provenance, and ethics',
					proposal: 'Develop a museum chapter around collecting, display, restitution, conservation, and public history.',
					decision: 'Approved. The final pack must include ethical questions for every object biography.',
					synthesis: 'Museums make arguments through acquisition, display, labels, conservation, and absence; provenance and restitution turn object history into ethical inquiry.',
					studyPrompt: 'List three provenance questions a museum label should help answer.',
				},
				{
					topic: 'comparison and final exam pack',
					proposal: 'Close with comparison templates, movement cards, visual-analysis prompts, and export the pack.',
					decision: 'Approved. The student vote requires practical exam structures.',
					synthesis: 'Strong art-history answers combine close looking, correct terminology, contextual evidence, and a focused thesis about meaning, function, or historical change.',
					studyPrompt: 'Draft a compare-and-contrast thesis for two works from different periods.',
				},
			],
		},
	];
}

function renderCommunicationTrail(course: CoursePlan, dayIndex: number) {
	const day = course.workdays[dayIndex];
	return [
		`architect: Proposed "${day.proposal}"`,
		`researcher: Confirmed the topic should connect primary course vocabulary to student-facing examples.`,
		`technical-writer: Drafted synthesis: ${day.synthesis}`,
		`reviewer: Requested a review prompt that tests transfer rather than memorization.`,
		`reporter: Recorded student approval and linked the workday to the export checklist.`,
	];
}

function renderKnowledgeBrief(course: CoursePlan, input: {
	allocationShare: number;
	projectMinutesPerDay: number;
	workdayCount: number;
	generatedAt: string;
	liveCodex: StudyKnowledgePackProjectResult['liveCodex'];
}) {
	return [
		mdFrontmatter({
			title: `${course.title} Knowledge Pack`,
			description: `Export-ready study knowledge pack for ${course.title}.`,
			order: 1,
			tags: [course.slug, 'study-group', 'agent-generated'],
		}),
		`# ${course.title} Knowledge Pack`,
		'',
		'## Core Objective',
		'',
		course.objective,
		'',
		'## Capacity And Allocation',
		'',
		`- Portfolio share: ${(input.allocationShare * 100).toFixed(2)}%`,
		`- Codex subscription provider share: ${(DEFAULT_PROVIDER_CAPACITY_SHARE * 100).toFixed(0)}% of ${DEFAULT_DAILY_ASSUMED_MINUTES} assumed daily minutes`,
		`- Project daily capacity: ${input.projectMinutesPerDay} minutes/day`,
		`- Simulated workdays: ${input.workdayCount}`,
		`- Generated at: ${input.generatedAt}`,
		'',
		'## Live Codex Pass',
		'',
		`- Status: ${input.liveCodex.status}`,
		`- Thread: ${input.liveCodex.threadId ?? 'n/a'}`,
		`- Summary: ${input.liveCodex.summary || 'n/a'}`,
		'',
		'## Research Agent Architecture',
		'',
		...course.agentArchitecture.map((agent) => `- ${agent}`),
		'',
		'## Working Synthesis',
		'',
		...course.workdays.flatMap((day, index) => [
			`### Workday ${String(index + 1).padStart(2, '0')}: ${day.topic}`,
			'',
			`**Approved proposal:** ${day.proposal}`,
			'',
			`**Student vote:** ${day.decision}`,
			'',
			`**Knowledge added:** ${day.synthesis}`,
			'',
			`**Study prompt:** ${day.studyPrompt}`,
			'',
		]),
		'## Acceptance Tests',
		'',
		'- The pack names a core objective before any daily work.',
		'- Every workday has a proposal, student vote, synthesis update, and study prompt.',
		'- The project allocation is one third of the study group portfolio.',
		'- The Codex subscription provider allocation is converted to minutes per day and attributed to the project.',
		'- The exported book package includes this brief as the canonical readable artifact.',
	].join('\n');
}

function renderWorkday(course: CoursePlan, index: number, generatedAt: string) {
	const day = course.workdays[index];
	const number = String(index + 1).padStart(2, '0');
	return [
		mdFrontmatter({
			title: `${course.title} Workday ${number}: ${day.topic}`,
			date: generatedAt.slice(0, 10),
			order: index + 1,
			tags: [course.slug, 'workday'],
		}),
		`# Workday ${number}: ${day.topic}`,
		'',
		'## Proposal',
		'',
		day.proposal,
		'',
		'## Student Vote',
		'',
		day.decision,
		'',
		'## Communication Trail',
		'',
		...renderCommunicationTrail(course, index).map((message) => `- ${message}`),
		'',
		'## Output',
		'',
		day.synthesis,
		'',
		'## Study Prompt',
		'',
		day.studyPrompt,
	].join('\n');
}

function renderProposal(course: CoursePlan, index: number, generatedAt: string) {
	const day = course.workdays[index];
	const number = String(index + 1).padStart(2, '0');
	return [
		mdFrontmatter({
			title: `${course.title} Proposal ${number}`,
			status: 'accepted',
			date: generatedAt.slice(0, 10),
			order: index + 1,
			tags: [course.slug, 'proposal'],
		}),
		`# Proposal ${number}: ${day.topic}`,
		'',
		day.proposal,
		'',
		'## Agent Rationale',
		'',
		`The agent group selected this work because the core objective for ${course.title} still needed durable coverage for ${day.topic}.`,
	].join('\n');
}

function renderDecision(course: CoursePlan, index: number, generatedAt: string) {
	const day = course.workdays[index];
	const number = String(index + 1).padStart(2, '0');
	return [
		mdFrontmatter({
			title: `${course.title} Decision ${number}`,
			status: 'accepted',
			date: generatedAt.slice(0, 10),
			order: index + 1,
			tags: [course.slug, 'decision'],
		}),
		`# Decision ${number}: ${day.topic}`,
		'',
		day.decision,
		'',
		'## Triggered Work',
		'',
		`Accepted proposal ${number} triggered the research, generation, optimization, and reporting messages for this workday.`,
	].join('\n');
}

function renderObjective(course: CoursePlan, generatedAt: string) {
	return [
		mdFrontmatter({
			title: `${course.title} Core Objective`,
			status: 'active',
			priority: 'very-important',
			date: generatedAt.slice(0, 10),
			tags: [course.slug, 'core-objective'],
		}),
		`# ${course.title} Core Objective`,
		'',
		course.objective,
	].join('\n');
}

function renderKnowledgePackIndex(course: CoursePlan, generatedAt: string, readablePackPath: string) {
	return [
		mdFrontmatter({
			title: `${course.title} Exported Knowledge Pack`,
			slug: `${course.slug}-knowledge-pack`,
			description: `Final exported study knowledge pack for ${course.title}.`,
			date: generatedAt.slice(0, 10),
			tags: [course.slug, 'knowledge-pack'],
		}),
		`# ${course.title} Exported Knowledge Pack`,
		'',
		`The readable exported Markdown package is available at \`${readablePackPath}\`.`,
		'',
		'It includes the core objective, accepted decisions, communication trail, workday synthesis, and study prompts.',
	].join('\n');
}

function renderReadableKnowledgePack(course: CoursePlan, input: {
	generatedAt: string;
	allocationShare: number;
	projectMinutesPerDay: number;
	workdayCount: number;
	sourceMarkdown: string[];
	bookPackagePath: string;
	liveCodex: StudyKnowledgePackProjectResult['liveCodex'];
}) {
	return [
		`# ${course.title} Knowledge Pack`,
		'',
		'Generated by the TreeSeed study-group capacity scenario.',
		'',
		'## Package Metadata',
		'',
		`- Generated at: ${input.generatedAt}`,
		`- Portfolio allocation: ${(input.allocationShare * 100).toFixed(2)}%`,
		`- Codex subscription capacity: ${(DEFAULT_PROVIDER_CAPACITY_SHARE * 100).toFixed(0)}% of ${DEFAULT_DAILY_ASSUMED_MINUTES} assumed daily minutes`,
		`- Project capacity: ${input.projectMinutesPerDay} minutes/day`,
		`- Simulated workdays: ${input.workdayCount}`,
		`- Treeseed exporter package: ${input.bookPackagePath}`,
		`- Live Codex status: ${input.liveCodex.status}`,
		`- Live Codex thread: ${input.liveCodex.threadId ?? 'n/a'}`,
		'',
		'## Live Codex Output',
		'',
		input.liveCodex.finalResponse || input.liveCodex.summary || 'No live Codex output recorded.',
		'',
		'## Source Bundle',
		'',
		...input.sourceMarkdown.flatMap((content, index) => [
			`<!-- SOURCE_FILE_${String(index + 1).padStart(2, '0')}_BEGIN -->`,
			content.trim(),
			`<!-- SOURCE_FILE_${String(index + 1).padStart(2, '0')}_END -->`,
			'',
		]),
	].join('\n');
}

function renderPortfolio(result: Omit<StudyKnowledgePackScenarioResult, 'portfolioPath' | 'summaryPath' | 'ok'>) {
	return [
		'# TreeSeed Study Group Knowledge Pack Demo',
		'',
		`Generated at: ${result.generatedAt}`,
		'',
		'## Student And Team',
		'',
		`- Student: ${result.student.name} (${result.student.id})`,
		`- Team: ${result.team.name} (${result.team.id})`,
		'',
		'## Codex Subscription Capacity Provider',
		'',
		`- Daily assumption: ${result.capacityProvider.dailyAssumedMinutes} minutes`,
		`- Allocated share: ${(result.capacityProvider.allocatedShare * 100).toFixed(0)}%`,
		`- Allocated minutes/day: ${result.capacityProvider.allocatedMinutesPerDay}`,
		`- Per-project minutes/day: ${result.capacityProvider.projectMinutesPerDay}`,
		`- Capabilities: ${result.capacityProvider.capabilities.join(', ')}`,
		'',
		'## Projects',
		'',
		...result.projects.flatMap((project) => [
			`### ${project.title}`,
			'',
			project.coreObjective,
			'',
			`- Allocation: ${(project.allocationShare * 100).toFixed(2)}%`,
			`- Daily minutes: ${project.dailyMinutes}`,
			`- Workdays: ${project.workdayCount}`,
			`- Proposals: ${project.proposalCount}`,
			`- Decisions: ${project.decisionCount}`,
			`- Communication messages: ${project.communicationMessageCount}`,
			`- Knowledge pack: ${project.readablePackPath}`,
			'',
		]),
	].join('\n');
}

function writeSyntheticResearchTemplate(projectRoot: string, course: CoursePlan) {
	for (const collection of [
		'pages',
		'notes',
		'questions',
		'objectives',
		'proposals',
		'decisions',
		'people',
		'agents',
		'books',
		'knowledge',
		'knowledge-packs',
		'workdays',
		'agent-tests',
	]) {
		mkdirSync(resolve(projectRoot, 'src/content', collection), { recursive: true });
	}
	writeText(resolve(projectRoot, 'src/manifest.yaml'), [
		`id: ${course.slug}`,
		'siteConfigPath: ./src/config.yaml',
		'content:',
		'  pages: ./src/content/pages',
		'  notes: ./src/content/notes',
		'  questions: ./src/content/questions',
		'  objectives: ./src/content/objectives',
		'  proposals: ./src/content/proposals',
		'  decisions: ./src/content/decisions',
		'  people: ./src/content/people',
		'  agents: ./src/content/agents',
		'  books: ./src/content/books',
		'  docs: ./src/content/knowledge',
		'  knowledge_packs: ./src/content/knowledge-packs',
		'  workdays: ./src/content/workdays',
		'  agent_tests: ./src/content/agent-tests',
		'features:',
		'  docs: true',
		'  books: true',
		'  notes: true',
		'  questions: true',
		'  objectives: true',
		'  proposals: true',
		'  decisions: true',
		'  agents: true',
		'  forms: false',
	].join('\n'));
	writeText(resolve(projectRoot, 'src/config.yaml'), [
		'site:',
		`  name: ${yamlString(course.title)}`,
		'  statement: Research, synthesize, and publish source-backed knowledge packs.',
		`  siteUrl: ${yamlString(`https://study.local/${course.slug}`)}`,
		'  githubRepository: https://example.invalid/treeseed-study-group',
		'  discordLink: https://example.invalid/study-group',
		'  summary: Synthetic research template for isolated agent package verification.',
	].join('\n'));
	writeText(resolve(projectRoot, 'src/content/pages/welcome.mdx'), [
		mdFrontmatter({ title: 'Welcome', slug: 'welcome' }),
		'# Welcome',
		'',
		'This synthetic research template is used when package CI does not have the starter repositories checked out.',
	].join('\n'));
}

function copyResearchTemplate(repoRoot: string, projectRoot: string, course: CoursePlan) {
	const templateRoot = resolve(repoRoot, 'starters/research/template');
	if (!existsSync(templateRoot)) {
		writeSyntheticResearchTemplate(projectRoot, course);
		return;
	}
	cpSync(templateRoot, projectRoot, { recursive: true });
	replaceInFile(resolve(projectRoot, 'src/manifest.yaml'), {
		'__SITE_SLUG__': course.slug,
	});
	replaceInFile(resolve(projectRoot, 'src/config.yaml'), {
		'__SITE_NAME__': course.title,
		'__SITE_URL__': `https://study.local/${course.slug}`,
		'__REPOSITORY_URL__': 'https://example.invalid/treeseed-study-group',
		'__DISCORD_URL__': 'https://example.invalid/study-group',
		'__CONTACT_EMAIL__': 'student@example.invalid',
	});
}

async function buildProject(input: {
	repoRoot: string;
	outputRoot: string;
	course: CoursePlan;
	generatedAt: string;
	workdayCount: number;
	allocationShare: number;
	projectMinutesPerDay: number;
	codexMode: 'required' | 'skip';
	codexReadiness: CodexProviderReadiness;
}) {
	const projectRoot = resolve(input.outputRoot, 'projects', input.course.slug);
	ensureEmptyDir(projectRoot);
	copyResearchTemplate(input.repoRoot, projectRoot, input.course);

	const workdays = input.course.workdays.slice(0, input.workdayCount);
	writeText(resolve(projectRoot, 'src/content/objectives/core-objective.mdx'), renderObjective(input.course, input.generatedAt));
	writeText(resolve(projectRoot, 'src/content/people/student-steward.mdx'), [
		mdFrontmatter({
			title: 'Student Steward',
			slug: 'student-steward',
			role: 'university-student',
			tags: ['student', 'study-group'],
		}),
		'# Student Steward',
		'',
		'Represents the student who owns the study group and casts approval votes for research decisions.',
	].join('\n'));
	writeText(resolve(projectRoot, 'src/content/notes/study-group-allocation.mdx'), [
		mdFrontmatter({
			title: `${input.course.title} Allocation`,
			tags: [input.course.slug, 'capacity'],
		}),
		'# Allocation',
		'',
		`This project receives ${(input.allocationShare * 100).toFixed(2)}% of the portfolio and ${input.projectMinutesPerDay} Codex subscription minutes per simulated workday.`,
	].join('\n'));
	for (let index = 0; index < workdays.length; index += 1) {
		writeText(resolve(projectRoot, `src/content/workdays/workday-${String(index + 1).padStart(2, '0')}.mdx`), renderWorkday(input.course, index, input.generatedAt));
		writeText(resolve(projectRoot, `src/content/proposals/proposal-${String(index + 1).padStart(2, '0')}.mdx`), renderProposal(input.course, index, input.generatedAt));
		writeText(resolve(projectRoot, `src/content/decisions/decision-${String(index + 1).padStart(2, '0')}.mdx`), renderDecision(input.course, index, input.generatedAt));
	}
	const liveCodex = await runLiveCodexCoursePass({
		repoRoot: input.repoRoot,
		course: input.course,
		workdays,
		codexMode: input.codexMode,
		codexReadiness: input.codexReadiness,
	});
	writeText(resolve(projectRoot, 'src/content/knowledge/research-brief/index.mdx'), renderKnowledgeBrief(input.course, {
		allocationShare: input.allocationShare,
		projectMinutesPerDay: input.projectMinutesPerDay,
		workdayCount: workdays.length,
		generatedAt: input.generatedAt,
		liveCodex,
	}));
	writeText(resolve(projectRoot, 'src/content/knowledge/research-brief/communication-trail.mdx'), [
		mdFrontmatter({
			title: `${input.course.title} Communication Trail`,
			order: 2,
			tags: [input.course.slug, 'communication'],
		}),
		`# ${input.course.title} Communication Trail`,
		'',
		...workdays.flatMap((_, index) => [
			`## Workday ${String(index + 1).padStart(2, '0')}`,
			'',
			...renderCommunicationTrail(input.course, index).map((message) => `- ${message}`),
			'',
		]),
	].join('\n'));
	writeText(resolve(projectRoot, 'src/content/knowledge/research-brief/study-cards.mdx'), [
		mdFrontmatter({
			title: `${input.course.title} Study Cards`,
			order: 3,
			tags: [input.course.slug, 'study-cards'],
		}),
		`# ${input.course.title} Study Cards`,
		'',
		...workdays.flatMap((day, index) => [
			`## Card ${String(index + 1).padStart(2, '0')}: ${day.topic}`,
			'',
			`Prompt: ${day.studyPrompt}`,
			'',
			`Answer frame: ${day.synthesis}`,
			'',
		]),
	].join('\n'));
	writeText(resolve(projectRoot, 'src/content/books/research-foundation.mdx'), [
		mdFrontmatter({
			title: `${input.course.title} Research Foundation`,
			slug: 'research-foundation',
			description: `The exported study book for ${input.course.title}.`,
			summary: `Core objective, accepted workdays, agent communication trail, and study prompts for ${input.course.title}.`,
			sectionLabel: 'Foundation',
			basePath: '/knowledge/research-brief/',
			landingPath: '/knowledge/research-brief/',
			downloadFileName: `${input.course.slug}-knowledge-pack.md`,
			downloadHref: `/books/${input.course.slug}-knowledge-pack.md`,
			downloadTitle: `Download the ${input.course.title} knowledge pack`,
			order: 1,
			exportRoots: ['./src/content/knowledge/research-brief'],
			tags: [input.course.slug, 'knowledge-pack'],
		}),
		`The ${input.course.title} research foundation book grows from the simulated study-group workdays.`,
	].join('\n'));

	const packageResult = await exportBookPackage('research-foundation', { projectRoot });
	const readablePackPath = resolve(input.outputRoot, 'knowledge-packs', `${input.course.slug}-knowledge-pack.md`);
	mkdirSync(dirname(readablePackPath), { recursive: true });
	const sourceMarkdown = [
		readFileSync(resolve(projectRoot, 'src/content/knowledge/research-brief/index.mdx'), 'utf8'),
		readFileSync(resolve(projectRoot, 'src/content/knowledge/research-brief/communication-trail.mdx'), 'utf8'),
		readFileSync(resolve(projectRoot, 'src/content/knowledge/research-brief/study-cards.mdx'), 'utf8'),
	];
	writeText(readablePackPath, renderReadableKnowledgePack(input.course, {
		generatedAt: input.generatedAt,
		allocationShare: input.allocationShare,
		projectMinutesPerDay: input.projectMinutesPerDay,
		workdayCount: workdays.length,
		sourceMarkdown,
		bookPackagePath: path.relative(input.repoRoot, packageResult.markdownPath).replaceAll(path.sep, '/'),
		liveCodex,
	}));
	writeText(resolve(projectRoot, 'src/content/knowledge-packs/final-knowledge-pack.mdx'), renderKnowledgePackIndex(input.course, input.generatedAt, path.relative(input.repoRoot, readablePackPath).replaceAll(path.sep, '/')));

	return {
		projectId: `project-${input.course.slug}`,
		projectRoot,
		title: input.course.title,
		coreObjective: input.course.objective,
		allocationShare: input.allocationShare,
		dailyMinutes: input.projectMinutesPerDay,
		workdayCount: workdays.length,
		proposalCount: workdays.length,
		decisionCount: workdays.length,
		communicationMessageCount: workdays.length * 5,
		bookPackage: {
			markdownPath: packageResult.markdownPath,
			indexPath: packageResult.indexPath,
			sourceFileCount: packageResult.sourceFileCount,
		},
		liveCodex,
		readablePackPath,
	} satisfies StudyKnowledgePackProjectResult;
}

async function runLiveCodexCoursePass(input: {
	repoRoot: string;
	course: CoursePlan;
	workdays: CoursePlan['workdays'];
	codexMode: 'required' | 'skip';
	codexReadiness: CodexProviderReadiness;
}): Promise<StudyKnowledgePackProjectResult['liveCodex']> {
	if (input.codexMode === 'skip') {
		return {
			status: 'skipped',
			threadId: null,
			summary: 'Live Codex invocation skipped by test option.',
			finalResponse: '',
		};
	}
	if (!input.codexReadiness.ok) {
		throw new Error(`Codex readiness is required for the study pack scenario: ${input.codexReadiness.blockingIssues.join('; ')}`);
	}
	const result = await runCodexSubscriptionTask({
		taskId: `study-pack:${input.course.slug}`,
		agentSlug: 'study-pack-live-reviewer',
		repoRoot: input.repoRoot,
		prompt: [
			`Course: ${input.course.title}`,
			`Core objective: ${input.course.objective}`,
			'',
			'Review this TreeSeed study-group project as the live Codex subscription agent.',
			'Return concise Markdown with:',
			'1. one sentence confirming whether the objective is clear;',
			'2. two strongest study-pack improvements;',
			'3. one acceptance-test risk to watch.',
			'',
			'Workday topics:',
			...input.workdays.map((day, index) => `${index + 1}. ${day.topic}: ${day.synthesis}`),
		].join('\n'),
		allowedPaths: ['test-results/study-knowledge-packs/**'],
		forbiddenPaths: ['.git/**', '.treeseed/secrets/**', 'node_modules/**'],
		sandboxMode: 'read_only',
		approvalPolicy: 'never',
		model: input.codexReadiness.defaultModel,
		timeoutMs: input.codexReadiness.timeoutMs,
		metadata: {
			subscriptionPlan: input.codexReadiness.subscriptionPlan,
			scenario: 'study-knowledge-pack',
			course: input.course.slug,
		},
	});
	return {
		status: result.status,
		threadId: result.threadId || null,
		summary: result.summary ?? '',
		finalResponse: result.finalResponse ?? '',
	};
}

export async function runStudyKnowledgePackScenario(options: StudyKnowledgePackScenarioOptions = {}): Promise<StudyKnowledgePackScenarioResult> {
	const repoRoot = resolve(options.repoRoot ?? discoverRepoRoot());
	const outputRoot = resolve(options.outputRoot ?? resolve(repoRoot, 'test-results/study-knowledge-packs'));
	const generatedAt = (options.now ?? new Date('2026-06-17T12:00:00.000Z')).toISOString();
	const workdayCount = Math.max(1, Math.min(options.workdayCount ?? DEFAULT_WORKDAY_COUNT, DEFAULT_WORKDAY_COUNT));
	const codexMode = options.codexMode ?? 'required';
	const codexReadiness = checkCodexProviderReadiness();
	const coursePlans = courses();
	const allocationShare = 1 / coursePlans.length;
	const allocatedMinutesPerDay = Math.round(DEFAULT_DAILY_ASSUMED_MINUTES * DEFAULT_PROVIDER_CAPACITY_SHARE);
	const projectMinutesPerDay = Math.floor(allocatedMinutesPerDay / coursePlans.length);

	ensureEmptyDir(outputRoot);
	const projects: StudyKnowledgePackProjectResult[] = [];
	for (const course of coursePlans) {
		projects.push(await buildProject({
			repoRoot,
			outputRoot,
			course,
			generatedAt,
			workdayCount,
			allocationShare,
			projectMinutesPerDay,
			codexMode,
			codexReadiness,
		}));
	}

	const partial = {
		generatedAt,
		student: {
			id: 'student-maya-rivera',
			name: 'Maya Rivera',
			role: 'university-student',
		},
		team: {
			id: 'team-campus-study-group',
			name: 'Campus Study Group',
		},
		capacityProvider: {
			id: 'provider-codex-subscription-study',
			kind: 'codex_subscription' as const,
			dailyAssumedMinutes: DEFAULT_DAILY_ASSUMED_MINUTES,
			allocatedShare: DEFAULT_PROVIDER_CAPACITY_SHARE,
			allocatedMinutesPerDay,
			projectMinutesPerDay,
			capabilities: ['codex', 'research', 'knowledge-pack-generation', 'proposal-review', 'study-guide-writing'],
		},
		codexReadiness,
		allocation: {
			totalProjects: coursePlans.length,
			projectShare: allocationShare,
		},
		projects,
	};
	const portfolioPath = resolve(outputRoot, 'portfolio.md');
	const summaryPath = resolve(outputRoot, 'scenario-summary.json');
	const result = {
		ok: projects.length === 3
			&& (codexMode === 'skip' || codexReadiness.ok)
			&& projects.every((project) =>
				project.workdayCount === workdayCount
				&& existsSync(project.readablePackPath)
				&& (codexMode === 'skip' || project.liveCodex.status === 'completed')),
		...partial,
		portfolioPath,
		summaryPath,
	} satisfies StudyKnowledgePackScenarioResult;
	writeText(portfolioPath, renderPortfolio(partial));
	writeText(summaryPath, JSON.stringify(result, null, 2));
	return result;
}
