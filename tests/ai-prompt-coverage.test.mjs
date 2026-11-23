import test from 'node:test';
import assert from 'node:assert/strict';
import {formatterPrompt, BULK_WECHAT_IMPORT_SKILL} from '../shared/tutoring-order-formatter.js';
import {splitWechatMessages, groupWechatMessages, bulkAuditProblems} from '../js/wechat-bulk-core.js';

const orderText=(id,grade='高一',subject='数学')=>
  id+'/家教\n【年级性别】'+grade+'，女孩\n【补习科目】'+subject+
  '\n【需要几个老师】1位\n【现阶段成绩】未提供\n【补课地址】津南区某小区'+
  '\n【一周几次】周末\n【每次几小时】2小时\n【对老师要求】无特殊要求\n【薪资】120元/小时';

test('dedicated bulk prompt is exhaustive, concise and decoupled from unrelated examples',()=>{
  const input=[{source:'微信导出',text:orderText('#2978-2','初三','历史')},
    {source:'微信导出',text:'#3019 招满了'}];
  const x=formatterPrompt('bulk_parse_orders',{messages:input});
  const data=JSON.parse(x.user);
  assert.deepEqual(data.expectedMessageIndices,[1,2]);
  assert.deepEqual(data.instruction.map(m=>m.sourceMessageIndex),[1,2]);
  assert.match(x.system,/逐条核对/);
  assert.match(x.system,/不得.*跳过重复|禁止.*跳过重复|跳过重复帖/);
  assert.match(x.system,/messageAudit/);
  assert.match(x.system,/#2978-2/);
  assert.match(x.system,/不.*自行减少订单数/);
  assert.match(x.system,/默认不公开/);
  assert.doesNotMatch(x.system,/昆裕里|金海湾花园|海景文苑/);
  assert.equal(x.system,BULK_WECHAT_IMPORT_SKILL);
});
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
test('default groups are smaller to avoid overflow and audit every WeChat source',()=>{
  const messages=Array.from({length:12},(_,i)=>({text:orderText('#'+(3001+i)),source:'测试导出'}));
  const batches=groupWechatMessages(messages);
  assert.deepEqual(batches.map(b=>b.messages.length),[5,5,2]);
});
test('every source index must be audited once, even for ignored chat or status updates',()=>{
  const m=[{text:orderText('#2975')},{text:'#2975 招满了'},{text:'普通聊天'}];
  const complete={
    orders:[{id:'#2975',sourceMessageIndices:[1]}],
    updates:[{id:'#2975',sourceMessageIndex:2,status:'已匹配'}],
    messageAudit:[
      {sourceMessageIndex:1,decision:'order'},
      {sourceMessageIndex:2,decision:'status_update'},
      {sourceMessageIndex:3,decision:'irrelevant'}
    ]
  };
  assert.deepEqual(bulkAuditProblems(m,complete),[]);
  assert(bulkAuditProblems(m,{...complete,messageAudit:complete.messageAudit.slice(0,2)}).length>0);
  assert(bulkAuditProblems(m,{...complete,orders:[]}).length>0);
  assert(bulkAuditProblems(m,{...complete,messageAudit:complete.messageAudit.map(x=>
    x.sourceMessageIndex===1?{sourceMessageIndex:1,decision:'irrelevant'}:x)}).length>0);
});
test('different numbered messages and already split child IDs are all counted, even if duplicated',()=>{
  const text=[
    '·发布人\n2026年11月21日 15:09\n'+orderText('#2978-1','初三','历史'),
    '·发布人\n2026年11月21日 15:14\n'+orderText('#2978-2','初三','道法'),
    '·发布人\n2026年11月21日 15:19\n'+orderText('#2978-1','初三','历史')
  ].join('\n\n');
  const msgs=splitWechatMessages(text);
  assert.equal(msgs.length,3);
  const result={
    orders:msgs.map((x,i)=>({id:i===1?'#2978-2':'#2978-1',sourceMessageIndices:[i+1]})),
    updates:[],
    messageAudit:msgs.map((x,i)=>({sourceMessageIndex:i+1,decision:'order'}))
  };
  assert.deepEqual(bulkAuditProblems(msgs,result),[]);
  assert(bulkAuditProblems(msgs,{...result,orders:result.orders.slice(0,2)}).length>0);
});
