import { describe,expect,it,vi } from 'vitest';
import { readCoreContextPack } from '../../src/provider/execution/core-context-pack.ts';

const file=(path:string,content:string,frontmatter:Record<string,unknown>={})=>({path,logicalPath:path.replace(/\.(?:md|mdx|ya?ml)$/u,''),content,frontmatter});
const response=(items:unknown[])=>({data:{result:{data:{items}}}});

function request(overrides:Record<string,unknown>={}) {
	const projectFiles=[
		file('agents/architect.mdx','# Architect',{slug:'architect',summary:'Owns architecture',groupIds:['architecture'],activityProfiles:{chat:{enabled:true,permissions:{content:{read:['**']}},outputContract:{response:{}}}},systemPrompt:'must not enter peer roster'}),
		file('agents/engineer.mdx','# Engineer',{slug:'engineer',summary:'Builds software',activityProfiles:{acting:{enabled:true,permissions:{content:{read:['**']}},outputContract:{patch:{}}}},systemPrompt:'must not enter peer roster'}),
		file('objectives/architecture.mdx','# Architecture objective',{title:'Architecture',status:'active',group_ids:['architecture']}),
		file('objectives/release.mdx','# Release objective',{title:'Release',status:'active',group_ids:['release']}),
	];
	const teamFiles=[
		file('README.md','# Team Library'),file('objectives/core.mdx','# Team objective'),
		file('objectives/communication.mdx','# Communicate',{title:'Communication',status:'active',group_ids:[]}),
	];
	const invoke=vi.fn(async (_operation:string,input:Record<string,any>)=>{
		const team=input.path.projectId==='team-project';
		const paths=Array.isArray(input.body.paths)?input.body.paths:[];
		if(_operation==='treedx.repositories.paths.list')return response((team?teamFiles:projectFiles).map(({path})=>({path})));
		const source=team?teamFiles:projectFiles;
		return response(paths.flatMap((path:string)=>source.filter((entry)=>entry.path===path||entry.logicalPath===path)));
	});
	return {assignmentId:'assignment-1',assignment:{metadata:{communication:{discussionId:'discussion-1',topicId:'topic-1',recipients:['@sdk/architect']},contextCapacity:{mode:'bounded',measurement:'bytes',defaultInitial:100_000,maximum:200_000,reservedOutput:10_000,transportPayloadBytes:250_000,measurementProvenance:{provider:'test',implementation:'utf8',version:null}}}},treeDx:{projectId:'sdk-project',repositoryId:'sdk-repo',baseRef:'sdk-ref',readRepositories:[],invoke},...overrides} as any;
}

describe('mandatory assignment context pack',()=>{
	it('compiles team anchors, the complete roster, group objectives, configured layers, and the live message',async()=>{
		const pack=await readCoreContextPack(request(),{
			identity:{manifest:{teamId:'team-1',projectId:'sdk-project',projectSlug:'sdk',agentProfile:{path:'agents/architect.mdx'},teamLibrary:{projectId:'team-project',repositoryId:'team-repo',immutableRef:'team-ref'}},sources:[
				{kind:'project-readme',path:'README.md',content:'# SDK'},
				{kind:'core-objective',path:'objectives/core',content:'# SDK objective'},
				{kind:'agent-profile',path:'agents/architect.mdx',content:'# Architect'},
			]},focused:{sources:[{layer:'agent',path:'architecture/principles.mdx',content:'# Principles'},{layer:'activity',path:'architecture/principles.mdx',content:'# Principles'},{layer:'activity',path:'standards/conversation.mdx',content:'# Conversation'}],queryLayers:{agent:['architecture'],activity:['chat']}},message:{path:'discussion/message.mdx',content:'Describe the SDK.',history:[{path:'discussion/prior.mdx',content:'Earlier context.'}]},
		});
		expect(pack.manifest.schemaVersion).toBe('treeseed.assignment-context-pack/v1');
		expect(pack.sources.map((source:any)=>source.kind)).toEqual(expect.arrayContaining(['project-readme','core-objective','agent-profile','team-readme','team-core-objective','agent-roster','discussion-message','discussion-history','discussion-state']));
		expect(pack.sources.some((source:any)=>source.path==='objectives/architecture.mdx')).toBe(true);
		expect(pack.sources.some((source:any)=>source.path==='objectives/release.mdx')).toBe(false);
		expect(pack.roster).toHaveLength(2);
		expect(JSON.stringify(pack.roster)).not.toContain('must not enter peer roster');
		expect(pack.manifest.sources).toContainEqual(expect.objectContaining({layer:'activity',path:'architecture/principles.mdx',disposition:'omitted',reason:expect.stringMatching(/^duplicate_of:/u)}));
	});

	it('fails closed when a mandatory Team Library anchor is absent',async()=>{
		const broken=request();
		broken.treeDx.invoke=vi.fn(async (operation:string,input:Record<string,any>)=>{
			if(operation==='treedx.repositories.paths.list')return response([]);
			if(input.path.projectId==='team-project')return response([file('README.md','# Team Library')]);
			return response([]);
		});
		await expect(readCoreContextPack(broken,{identity:{manifest:{teamId:'team-1',projectId:'sdk-project',projectSlug:'sdk',agentProfile:{path:'agents/architect.mdx'},teamLibrary:{projectId:'team-project',repositoryId:'team-repo',immutableRef:'team-ref'}},sources:[]},focused:{},message:{}})).rejects.toThrow(/README\.md and objectives\/core are mandatory/u);
	});
});
