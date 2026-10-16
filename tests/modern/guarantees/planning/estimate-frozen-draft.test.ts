import{expect,it}from'vitest';
import{state}from'../../kernel/architecture/golden-readback-fixture.ts';
import{row,type Row}from'../../../acceptance/acceptance-cli.ts';
import{verifyEstimatePublications}from'../../../acceptance/workday/support/planning/estimate-evidence.ts';

// Controlled unit inputs only. The original native case reads independently committed Git bytes.
it('requires the original frozen draft identity and bytes before accepting mutually consistent genuine-estimate publication and ready proposal readbacks',()=>{
 const assignments=state.replies.get('assignments list')!.items as Row[],run=state.replies.get('workdays show')!.run as Row,proposal=state.replies.get('proposals show')!,provenance=row(row(proposal.metadata).contentProvenance);
 const reference={store:'treedx',model:'proposal',id:proposal.id,revision:proposal.activeVersion,digest:'sha256:'+proposal.activeContentHash,repository:provenance.repositoryId,commit:provenance.commitSha,path:provenance.contentPath};
 const readFile=(ref:Row)=>{const response=state.replies.get('library read '+ref.path+' --ref '+ref.commit);if(!response)throw new Error('Original controlled publication missing');return row(response.result.files[0]);},ready=readFile(reference);
 const owner=assignments.find(item=>row(row(item.assignmentAttempt).effectiveProfile).activity==='estimating');if(!owner)throw new Error('Original estimating owner required');
 const draft=structuredClone(row(row(owner.assignmentAttempt).sourceRef)),held=structuredClone({assignments,run,reference,ready,draft});
 const inspect=(frozen:unknown)=>Reflect.apply(verifyEstimatePublications,undefined,[assignments,run,reference,ready,readFile,frozen]);
 expect(()=>inspect(draft)).not.toThrow();
 for(const changed of[undefined,null,{}, {...draft,id:'foreign'}, {...draft,repository:'foreign'}, {...draft,path:'proposals/foreign.mdx'}, {...draft,commit:'staging'}, {...draft,digest:'sha256:'+'f'.repeat(64)}])expect.soft(()=>inspect(changed)).toThrow('ACCEPTANCE_ESTIMATE_AUTHORITY');
 expect({assignments,run,reference,ready,draft}).toEqual(held);expect(()=>inspect(draft)).not.toThrow();
});
