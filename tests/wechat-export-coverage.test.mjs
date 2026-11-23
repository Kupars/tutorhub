import test from 'node:test';
import assert from 'node:assert/strict';
import {splitWechatMessages,groupWechatMessages,missingStructuredOrderSources} from '../js/wechat-bulk-core.js';

const exported = [
  '·家教信息发布人',
  '2026年11月21日 15:09',
  '#2975/初三数学、物理、化学家教',
  '【年级性别】初三，男孩',
  '【补习科目】数学、物理、化学',
  '【需要几个老师】1位',
  '【薪资】90～110元/小时（可报价）',
  '',
  '·其他发布人',
  '2026年11月21日 15:14',
  '#2976/初三物理家教',
  '【年级性别】初三，女孩',
  '【补习科目】物理',
  '【薪资】90～110元/小时（可报价）',
  '',
  '·家教信息发布人',
  '2026年11月22日 10:12',
  '#可网课',
  '#2995/高三化学家教',
  '【年级性别】高三，男孩',
  '【补习科目】化学',
  '【薪资】130～150元/小时（可报价）',
  '',
  '·家教信息发布人',
  '2026年11月22日 10:18',
  '#2533初一英语家教',
  '【年级性别】初一，女孩',
  '【补习科目】英语',
  '【薪资】80元/小时'
].join('\n');

test('WeChat merged-forward TXT keeps speaker, Chinese timestamp, and order together',()=>{
  const messages=splitWechatMessages(exported,'微信聊天记录.txt');
  assert.equal(messages.length,4);
  assert.deepEqual(messages.map(x=>x.text.match(/^#\d{3,7}(?:-\d+)?/m)?.[0]),
    ['#2975','#2976','#2995','#2533']);
  for(const m of messages){
    assert.match(m.text,/2026年11月/);
    assert.match(m.text,/【补习科目】/);
    assert.match(m.text,/^·/);
  }
  const batches=groupWechatMessages(messages);
  assert.equal(batches.length,1);
  assert.equal(batches[0].messages.length,4);
});
test('standard numbered text still splits into exactly one message per real listing',()=>{
  const messages=splitWechatMessages(
    '#2978-1/初三历史家教\n【年级性别】初三\n【补习科目】历史\n【薪资】90元\n\n\n'+
    '#2978-2/初三道法家教\n【年级性别】初三\n【补习科目】道法\n【薪资】90元');
  assert.equal(messages.length,2);
});
test('AI must cover each structured #order source; no silent acceptance of partial output',()=>{
  const messages=splitWechatMessages(exported);
  const orders=[
    {id:'#2975',sourceMessageIndices:[1]},
    {id:'#2976',sourceMessageIndices:[2]},
    {id:'#2533',sourceMessageIndices:[4]}
  ];
  assert.deepEqual(missingStructuredOrderSources(messages,orders),[{sourceIndex:3,id:'#2995'}]);
  assert.deepEqual(missingStructuredOrderSources(messages,[
    ...orders,{id:'#2995',sourceMessageIndices:[3]}
  ]),[]);
});
test('previously split order IDs count as separate listings and preserve child numbers',()=>{
  const messages=splitWechatMessages(
    '#2978-1/历史家教\n【年级性别】初三\n【补习科目】历史\n\n\n'+
    '#2978-2/道法家教\n【年级性别】初三\n【补习科目】道法');
  assert.deepEqual(missingStructuredOrderSources(messages,[
    {id:'#2978-1',sourceMessageIndices:[1]},
    {id:'#2978-2',sourceMessageIndices:[2]}
  ]),[]);
  assert.deepEqual(missingStructuredOrderSources(messages,[
    {id:'#2978',sourceMessageIndices:[1]}
  ]),[{sourceIndex:1,id:'#2978-1'},{sourceIndex:2,id:'#2978-2'}]);
});
