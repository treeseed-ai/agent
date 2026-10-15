import {expect,it} from 'vitest';
import {proposalFeedbackFixture} from './proposal-feedback-fixture.ts';
import {verifyProposalFeedback} from '../../../acceptance/workday/context-custody.test.ts';
import {row,type Row} from '../../../acceptance/acceptance-cli.ts';

it('normal proposal readback accepts zero blockers and exact prior resolutions while denying incomplete foreign late duplicate changed or interrupted authority without repairing history',()=>{
 const f=proposalFeedbackFixture(),empty=structuredClone({items:f.items,proposal:f.proposal,files:f.files});expect(verifyProposalFeedback(f.items,'controlled',f.read)).toEqual({seen:1,resolved:0});expect({items:f.items,proposal:f.proposal,files:f.files}).toEqual(empty);
 f.proposal.events=structuredClone(f.blockers);const original=structuredClone({items:f.items,proposal:f.proposal,files:f.files});expect(verifyProposalFeedback(f.items,'controlled',f.read)).toEqual({seen:1,resolved:1});expect({items:f.items,proposal:f.proposal,files:f.files}).toEqual(original);
 const changes:Array<(f:ReturnType<typeof proposalFeedbackFixture>)=>void>=[
  f=>{f.proposal.status='ready';},f=>{f.proposal.activeVersion=99;},f=>{f.proposal.activeContentHash='0'.repeat(64);},
  f=>{row(f.proposal.readiness).unresolvedBlockerCount=1;},f=>{row(f.proposal.readiness).votingReady=false;},f=>{row(f.proposal.readiness).executionPlanReady=false;},
  f=>{f.proposal.events=null;},f=>{f.proposal.events=Array.from({length:100},()=>structuredClone(f.blockers[0]));},f=>{f.proposal.events=[f.blockers[0]];},
  f=>{(f.proposal.events as Row[]).push(structuredClone(f.blockers[1]!));},f=>{(f.proposal.events as Row[])[1]!.createdAt='2026-09-27T00:00:05.000Z';},
  f=>{(f.proposal.events as Row[])[1]!.proposalVersion=99;},f=>{f.files.delete(String(f.questionRef.commit)+':'+String(f.questionRef.path));},
  f=>{const file=row((row(f.files.get(String(f.resolutionRef.commit)+':'+String(f.resolutionRef.path))!.result).files as Row[])[0]);file.content=String(file.content)+'changed';},
 ];
 for(const change of changes){const denied=proposalFeedbackFixture();denied.proposal.events=structuredClone(denied.blockers);change(denied);const before=structuredClone({items:denied.items,proposal:denied.proposal,files:denied.files});expect(()=>verifyProposalFeedback(denied.items,'controlled',denied.read)).toThrow();expect({items:denied.items,proposal:denied.proposal,files:denied.files}).toEqual(before);}
 const held=structuredClone(original);expect(()=>verifyProposalFeedback(f.items,'controlled',()=>{throw new Error('Retained original read interruption');})).toThrow('Retained original read interruption');expect(verifyProposalFeedback(f.items,'controlled',f.read)).toEqual({seen:1,resolved:1});expect({items:f.items,proposal:f.proposal,files:f.files}).toEqual(held);
});
