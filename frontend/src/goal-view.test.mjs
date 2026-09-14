import { test } from 'node:test';
import assert from 'node:assert/strict';
import { goalView } from './goal-view.ts';
const plan = {id:'p',title:'目标',status:'accepted',input:{goal:{detail:'原目标'}},nodes:[{id:'T1',dependsOn:[]},{id:'T2',dependsOn:['T1']},{id:'T3',dependsOn:['T1']},{id:'T4',dependsOn:['T2','T3']}]};
const fixture = () => [{id:'source',title:'原目标',status:'open',deadline:''}, ...plan.nodes.map(n => ({id:n.id,nodeId:n.id,planId:'p',title:n.id,status:'open',dependencies:n.dependsOn,deadline:''}))];
test('frontier advances through fork and join without flattening goals', () => {
 const tasks=fixture(); const next=()=>goalView([plan],tasks).groups[0].ready.map(t=>t.id);
 assert.deepEqual(next(),['T1']); tasks[1].status='done'; assert.deepEqual(next(),['T2','T3']);
 tasks[2].status='done'; assert.deepEqual(next(),['T3']); tasks[3].status='done'; assert.deepEqual(next(),['T4']);
 assert.equal(goalView([plan],tasks).standalone.length,0);
});
test('skipped or missing prerequisites cannot unlock a dependent action', () => {
 const tasks=fixture(); tasks[1].status='skipped'; assert.deepEqual(goalView([plan],tasks).groups[0].ready,[]);
 tasks.splice(1,1); assert.deepEqual(goalView([plan],tasks).groups[0].ready,[]);
});
test('draft previews root nodes and preserves independent tasks', () => {
 const tasks=[fixture()[0],{id:'other',title:'独立事项',status:'open',deadline:''}];
 const result=goalView([{...plan,status:'draft'}],tasks);
 assert.deepEqual(result.groups[0].preview.map(n=>n.id),['T1']); assert.equal(result.standalone[0].id,'other');
});
test('stable source id survives rename; ambiguous titles are not merged', () => {
 const tasks=fixture(); tasks[0].title='新名称';
 assert.equal(goalView([{...plan,sourceTaskId:'source'}],tasks).groups[0].source.id,'source');
 tasks[0].title='原目标'; tasks.push({...tasks[0],id:'duplicate'});
 assert.equal(goalView([plan],tasks).groups[0].source,undefined);
});
test('ready actions retain exact saved deadlines', () => {
 const tasks=fixture(); tasks[1].deadline='2026-10-01';
 assert.equal(goalView([plan],tasks).groups[0].ready[0].deadline,'2026-10-01');
});
