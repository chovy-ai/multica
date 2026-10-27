// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { LocalConversation, LocalConversationEvent, LocalConversationTurn } from '@multica/tutti-agent-gui-host/local-protocol';
import { localSideActivity } from './local-side-activity';
const at = '2026-10-27T09:00:00Z';
function conversation(status: LocalConversationTurn['status'], events: LocalConversationEvent[] = []): LocalConversation {
  return { id: 'side', title: 'Source title is not a work summary', provider: 'claude', cwd: '/project', model: null, pinned: false, archived: false,
    createdAt: at, updatedAt: at, messages: [{ id:'old', role:'assistant', turnId:'old-turn', content:'Previous result',createdAt:at }],
    turns: [{ id:'current',status,events,createdAt:at }] };
}
describe('side activity', () => {
  it.each(['running','completed','failed','cancelled'] as const)('uses the actual %s turn status without borrowing previous output', (state) => {
    expect(localSideActivity(conversation(state))).toMatchObject({state, spinning: state === 'running',output:''});
  });
  it('has no invented summary for an empty conversation', () => {
    expect(localSideActivity()).toMatchObject({state:'idle',output:''});
    const session=conversation('completed'); session.turns=[];session.messages=[];
    expect(localSideActivity(session)).toMatchObject({state:'idle',output:''});
  });
  it('shows tool progress, but never tool arguments, results, or reasoning content', () => {
    const session=conversation('running', [
      {seq:1,type:'tool_use',tool:'Read',input:{file_path:'/secret'},call_id:'read',created_at:at},
      {seq:2,type:'tool_result',call_id:'read',output:'sensitive output',created_at:at},
      {seq:3,type:'tool_use',tool:'Bash',input:{command:'secret command'},call_id:'bash',created_at:at},
    ]);
    expect(localSideActivity(session)).toMatchObject({tool:'Bash',completedTools:1,totalTools:2,output:''});
    session.turns[0]!.events.push({seq:4,type:'thinking',content:'private reasoning',created_at:at});
    expect(localSideActivity(session)).toMatchObject({thinking:true,tool:undefined,output:''});
    expect(JSON.stringify(localSideActivity(session))).not.toMatch(/secret|private|sensitive/);
  });
  it('combines streaming text and uses the saved final response on completion', () => {
    const session=conversation('running',[
      {seq:1,type:'text',content:'Checked ',created_at:at},{seq:2,type:'text',content:'the layout.',created_at:at},
    ]);
    expect(localSideActivity(session).output).toBe('Checked the layout.');
    session.turns[0]!.status='completed';
    session.messages.push({id:'final',role:'assistant',turnId:'current',content:'Fixed the layout and verified both themes.',createdAt:at});
    expect(localSideActivity(session).output).toBe('Fixed the layout and verified both themes.');
  });
  it('distinguishes an unanswered question from active processing', () => {
    const session=conversation('running'); session.turns[0]!.questions=[{request_id:'q',status:'pending',questions:[],createdAt:at,updatedAt:at}];
    expect(localSideActivity(session)).toMatchObject({state:'waiting',spinning:false});
  });
  it('keeps running background work visible even when a later turn finished', () => {
    const session=conversation('completed');
    session.turns[0]!.backgroundTasks=[{id:'bg',description:'Verify dark theme',status:'running'}];
    session.turns.push({id:'later',status:'completed',createdAt:at,events:[]});
    expect(localSideActivity(session)).toMatchObject({state:'running',spinning:true,background:'Verify dark theme'});
    session.turns[0]!.backgroundTasks[0]!.status='completed';
    expect(localSideActivity(session)).toMatchObject({state:'completed',spinning:false});
  });
  it('does not display the last turn as the activity of a newly dispatching prompt', () => {
    const session=conversation('completed', [{seq:1,type:'tool_use',tool:'Read',call_id:'old',created_at:at}]);
    session.promptQueue={revision:1,paused:false,items:[],dispatchingRequestId:'next'};
    session.messages.push({id:'final',role:'assistant',turnId:'current',content:'Old result',createdAt:at});
    expect(localSideActivity(session)).toMatchObject({state:'running',output:'',tool:undefined,totalTools:0});
  });
  it('retains errors and partial text after a failure or cancellation', () => {
    const session=conversation('failed',[{seq:1,type:'text',content:'Partial result',created_at:at}]);
    session.turns[0]!.error='Connection interrupted';
    expect(localSideActivity(session)).toMatchObject({state:'failed',spinning:false,error:'Connection interrupted',output:'Partial result'});
    session.turns[0]!.status='cancelled';
    expect(localSideActivity(session)).toMatchObject({state:'cancelled',spinning:false,error:undefined,output:'Partial result'});
  });
});
