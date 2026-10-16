import {campaignCliFixture} from '../../lifecycle/campaign-cli-fixture.ts';
import {expect,it,vi} from 'vitest';
import {assignmentAttemptSchema} from '@treeseed/sdk/agent-capacity';
import {request} from '../../../kernel/provider-kernel-fixture.ts';
import {liveAssignmentRecord} from '../live-assignment-fixture.ts';
import {row,type Row} from '../../../../acceptance/acceptance-cli.ts';
import {inspectLiveAssignmentProfile} from '../../../../acceptance/workday/support/monitoring/live-assignment-records.ts';
import {planningWindowScope} from './planning-window-fixture.ts';
const {state,workdayId,observed,transport}=campaignCliFixture();

it('original campaign denies early or phase-contradictory assignments before profile inspection approval or final golden gates without changing terminal evidence',async()=>{
 const failures:Row[]=[];
 for(const mode of ['early','phase']){
  const raw=request().assignment.assignmentAttempt!,attempt=assignmentAttemptSchema.parse({...raw,workdayId,projectId:'8cbfb810-6da5-4da2-9ae9-cad53101253f',deadline:'2026-09-13T12:01:00.000Z'}),item=liveAssignmentRecord(attempt),scope=planningWindowScope(item);
  row(row(row(item.explanation).metadata).allocation).opportunity=scope.opportunity;
  if(mode==='early'){row(item.assignmentAttempt).createdAt='2026-09-13T11:59:59.999Z';item.createdAt='2026-09-13T11:59:59.999Z';}else row(scope.opportunity).phase='planning';
  const shown={...observed('completed'),run:{...scope.run,status:'completed'}},held=structuredClone({item,shown,freeze:state.freeze});
  state.verify.mockReset();vi.mocked(inspectLiveAssignmentProfile).mockClear();transport(()=>shown);
  state.evidence.mockImplementation((args:string[])=>args[0]==='assignments'?[item]:[]);
  state.inspect.mockImplementation((_run,items,_retained,inspect)=>{for(const value of items)inspect(value);});
  await expect(state.run!()).rejects.toThrow('ACCEPTANCE_PLANNING_WINDOW');expect(inspectLiveAssignmentProfile).not.toHaveBeenCalled();expect(state.verify).not.toHaveBeenCalled();expect(state.read.mock.calls.filter(call=>call[0][1]==='evaluate'||call[0][1]==='stop')).toEqual([]);expect({item,shown,freeze:state.freeze}).toEqual(held);failures.push(held);
 }
 expect(failures).toHaveLength(2);
});
