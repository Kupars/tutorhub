import test from 'node:test';
import assert from 'node:assert/strict';
import {formatterPrompt} from '../shared/tutoring-order-formatter.js';

test('normal and draft revision prompts remain separate and preserve real user instructions',()=>{
  const parse=formatterPrompt('parse_orders',{text:'高二两名学生分别找数学物理老师'});
  assert.match(parse.user,/两名学生/);
  assert.match(parse.system,/一名老师带多科/);
  assert.match(parse.system,/不能复制案例/);
  assert.doesNotMatch(parse.system,/messageAudit/);
  const revise=formatterPrompt('revise_drafts',{instruction:'把原单改成周末',drafts:[{id:'#2811',subject:'数学'}]});
  assert.match(revise.user,/#2811/);
  assert.match(revise.user,/周末/);
});
