import test from 'node:test';
import assert from 'node:assert/strict';
import {splitWechatMessages, redactWechatText, groupWechatMessages,
  normalizeImportDocuments, findBulkDuplicate, safeBulkUpdates} from '../js/wechat-bulk-core.js';

test('splits distinct numbered WeChat messages without splitting the nine-field order',()=>{
  const messages=splitWechatMessages(
    '#2811/高三生物家教\n【年级性别】高三女孩\n【补习科目】生物\n【薪资】130元/小时\n\n'+
    '#2861/高一化学家教\n【年级性别】高一男孩\n【补习科目】化学\n【薪资】120元/小时', '微信导出.txt');
  assert.equal(messages.length,2);
  assert.match(messages[0].text,/【薪资】130/);
  assert.match(messages[1].text,/#2861/);
});
test('splits timestamp headers and double-blank separators',()=>{
  assert.equal(splitWechatMessages('2026-11-20 12:33 张三\n内容一\n2026-11-20 12:34 李四\n内容二').length,2);
  assert.equal(splitWechatMessages('第一条消息\n\n\n第二条消息').length,2);
  assert.equal(splitWechatMessages('【年级性别】高一\n【补习科目】数学\n【薪资】120\n【年级性别】高二\n【补习科目】英语').length,2);
});
test('redacts private information before third-party AI request',()=>{
  const redacted=redactWechatText('微信：微信号 cheerpup012，电话13800138000，邮箱 abc@example.com，12号楼2单元301室');
  assert.doesNotMatch(redacted,/13800138000|abc@example.com|cheerpup012|301室/);
  assert.match(redacted,/已隐藏/);
});
test('packs messages in bounded sequential API batches and rejects oversize messages',()=>{
  const items=Array.from({length:26},(_,i)=>({text:'#'+(3000+i)+'/高一数学\n【补习科目】数学',source:'聊天记录'}));
  const grouped=groupWechatMessages(items,9000,10);
  assert.equal(grouped.length,3);
  assert.deepEqual(grouped.map(x=>x.messages.length),[10,10,6]);
  const tooLong=groupWechatMessages([{text:'字'.repeat(9001),source:'大文件'}]);
  assert.equal(tooLong[0].status,'failed');
});
test('ignores duplicate exported messages, but preserves different sources',()=>{
  const result=normalizeImportDocuments([{name:'a',messages:[{text:'甲',source:'a'},{text:'乙',source:'a'}]},
    {name:'b',messages:[{text:'甲',source:'b'},{text:'丙',source:'b'}]}]);
  assert.deepEqual(result.map(x=>x.text),['甲','乙','丙']);
});
test('exact order number collision is a hard block, same-location match is a review',()=>{
  const old={id:'#2811',orderNumber:'#2811',grade:'高三',subject:'生物',
    publicAddress:'天津市南开区大学城某苑',weeklyFrequency:'每周一'};
  const collision=findBulkDuplicate({...old,subject:'数学'},[old]);
  assert.equal(collision.hard,true);
  const similar=findBulkDuplicate({...old,id:'#3999',orderNumber:'#3999'},[old]);
  assert.equal(similar.hard,false);
  assert.equal(findBulkDuplicate({...old,id:'#3999',orderNumber:'#3999',publicAddress:'天津市河西区新小区'},[old]),null);
});
test('status updates require a matching existing ID and an explicit source reference',()=>{
  const existing=[{id:'#2811',orderNumber:'#2811'}];
  const messages=[{index:1,text:'#2811 招满了'}];
  const a=safeBulkUpdates([{id:'#2811',status:'已匹配',sourceMessageIndex:1}],messages,existing);
  assert.equal(a[0].verified,true);
  assert.equal(a[0].selected,false);
  assert.equal(safeBulkUpdates([{id:'#2812',status:'招募中',sourceMessageIndex:1}],messages,existing)[0].verified,false);
  assert.equal(safeBulkUpdates([{id:'#2811',status:'已匹配',sourceMessageIndex:2}],messages,existing)[0].verified,false);
});
