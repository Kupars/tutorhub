import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { onRequestPost } from '../functions/api/ai.js';

const env={TUTOR_KV:{get:async()=>null,put:async()=>{}},
  AUTH_SECRET:'bulk-test-secret-0123456789-0123456789',
  ADMIN_PASSWORD:'strong-bulk-admin-password',
  OPENAI_API_KEY:'fake-bulk-token',
  OPENAI_BASE_URL:'https://example.ai/v1',
  OPENAI_MODEL:'bulk-compatible-model'};
function token(){
  const payload=btoa(JSON.stringify({id:'admin',role:'admin',jti:'bulk-test-012345678901',exp:Date.now()+60000}));
  return payload+'.'+createHmac('sha256',env.AUTH_SECRET).update(payload).digest('hex');
}
function request(auth=true) {
  return new Request('https://example.pages.dev/api/ai',{method:'POST',
    headers:{'Content-Type':'application/json',...(auth?{Authorization:'Bearer '+token()}:{})},
    body:JSON.stringify({action:'bulk_parse_orders',payload:{
      messages:[{source:'消息1',text:'#2811/高三生物家教'},{source:'消息2',text:'#2811 招满了'}]
    }})});
}
test('bulk AI requires admin authentication, no public model spending',async()=>{
  const original=globalThis.fetch;let calls=0;
  globalThis.fetch=async()=>{calls++;throw Error('No model call expected');};
  try{
    const res=await onRequestPost({request:request(false),env});
    assert.equal(res.status,401);assert.equal(calls,0);
  }finally{globalThis.fetch=original;}
});
test('bulk AI returns closed-by-default drafts and unexecuted updates as suggestions',async()=>{
  const original=globalThis.fetch;let prompt='';
  globalThis.fetch=async(url, options)=>{
    assert.equal(url,'https://example.ai/v1/chat/completions');
    const body=JSON.parse(options.body);
    prompt=body.messages[0].content+'\n'+body.messages[1].content;
    return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({
      reply:'提取一张单和一条状态更新',
      orders:[{id:'#2811',grade:'高三',subject:'生物',status:'已匹配',sourceMessageIndices:[1]}],
      updates:[{id:'#2811',status:'已匹配',sourceMessageIndex:2,reason:'已招满'}],
      questions:[]
    })}}]}),{status:200});
  };
  try{
    const res=await onRequestPost({request:request(),env});
    assert.equal(res.status,200);
    const data=await res.json();
    assert.equal(data.result.orders[0].sourceMessageIndices[0],1);
    assert.equal(data.result.updates[0].sourceMessageIndex,2);
    assert.match(prompt,/不同微信消息/);
    assert.match(prompt,/默认不公开/);
    assert(!JSON.stringify(data).includes('fake-bulk-token'));
  }finally{globalThis.fetch=original;}
});
test('bulk AI can return status-only messages with no new tutoring orders',async()=>{
  const original=globalThis.fetch;
  globalThis.fetch=async()=>new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({
    orders:[],updates:[{id:'#2811',status:'已匹配',sourceMessageIndex:1}]
  })}}]}),{status:200});
  try{
    const res=await onRequestPost({request:request(),env});
    assert.equal(res.status,200);
    assert.deepEqual((await res.json()).result.orders,[]);
  }finally{globalThis.fetch=original;}
});
