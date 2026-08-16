import { describe,expect,it,vi } from 'vitest';
import { resolveExecutionTreeDxContext } from '../../../src/agents/handlers/execution-content-context.ts';

describe('verified context query assignment input',()=>{
	it('executes an admitted exact query in real time instead of injecting its test result',async()=>{
		const definitionRef='a'.repeat(40); const runtimeRef='b'.repeat(40);
		const buildContext=vi.fn(async()=>({resolvedRef:runtimeRef,nodes:[{node:{id:'guide-node',path:'src/content/knowledge/guide.md',text:'Current guide context'}}],edges:[],totalTokenEstimate:12}));
		const readRepositoryFiles=vi.fn(async(input:{paths:string[]})=>({payload:{files:[{path:input.paths[0],text:input.paths[0]?.includes('agent-context-queries')?query:'content'}]}}));
		const query=`---\nid: guide\ntitle: Guide\ndescription: Current Guide context.\nrevision: 2\nmaturity: validated\npurpose: research\nquery: Current Guide\ntarget:\n  kind: content\n  models: [knowledge]\n  paths: [/src/content/knowledge/guide.md]\nrelations: []\ndepth: 0\nresultLimit: 1\ncontextBudget: { maxItems: 1, maxCharacters: 2000 }\ntokenBudget: 500\nformat: full\nrequired: true\n---\n`;
		const result=await resolveExecutionTreeDxContext({
			repoRoot:'/provider/data/project-a',agent:{slug:'architect',context:{queries:[]}},
			capacity:{assignmentId:'assignment-a',treedxProxyHandle:{repositoryId:'repo-a'},assignment:{metadata:{contentRoot:'src/content'}}},
			treeDx:{buildContext,readRepositoryFiles},
		} as never,{model:'objective',id:'core',title:'Core'},{objectiveId:'core',contextDefinitionRef:definitionRef,contextRuntimeRef:runtimeRef,contextQueryRefs:[{kind:'query',id:'guide',revision:2}],contextQueryChecks:[{
			id:'check-a',testRef:'test:guide',definition:{kind:'query',id:'guide',revision:2,commit:definitionRef},
			checkedAt:'2026-08-13T20:00:00.000Z',expiresAt:'2026-08-14T20:00:00.000Z',resultDigest:'test-result-digest',stats:{itemCount:1},assertions:[],
		}]});
		expect(result.evidence).toEqual(expect.arrayContaining([expect.objectContaining({
			id:'treedx-realtime-context-query:guide',source:'treedx_realtime_context_query',pack:expect.objectContaining({nodes:expect.any(Array)}),
		})]));
		expect(buildContext).toHaveBeenCalledOnce();
		expect(buildContext).toHaveBeenCalledWith(expect.objectContaining({ref:runtimeRef}));
		expect(readRepositoryFiles).toHaveBeenCalledWith(expect.objectContaining({ref:definitionRef}));
	});
});
