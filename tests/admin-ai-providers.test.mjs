import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {saveAIProvider,deleteAIProvider,activateAIProvider,resolveAIProvider,loadAIRegistry,safeAIRegistry} from "../shared/ai-provider-registry.js";
import {onRequest as storeHandler} from "../functions/api/store.js";
import {onRequestPost as aiHandler} from "../functions/api/ai.js";

function fixture(){
  const storage=new Map();
  const env={TUTOR_KV:{
    async get(key){return storage.get(key) || null;},
    async put(key,value){storage.set(key,value);}
  },ADMIN_PASSWORD:"test-admin-password",ADMIN_EMAIL:"owner@example.com",
    AUTH_SECRET:"high-entropy-simulation-test-secret-0123456789",
    OPENAI_API_KEY:"environment-fallback-key",OPENAI_BASE_URL:"https://env-provider.example.net/v1",
    OPENAI_MODEL:"fallback-model"};
  return {env,storage};
}
function token(secret){
  const data=btoa(JSON.stringify({id:"admin",role:"admin",jti:"test-models-0123456789",exp:Date.now()+60000}));
  return data+"."+createHmac("sha256",secret).update(data).digest("hex");
}
async function store(env,action,authenticated=true){
  const res=await storeHandler({env,request:new Request("https://tutor.example.net/api/store",{
    method:"POST",headers:{"Content-Type":"application/json",Origin:"https://tutor.example.net",
      ...(authenticated?{Authorization:"Bearer "+token(env.AUTH_SECRET)}:{})},
    body:JSON.stringify(action)})});
  return {status:res.status,data:await res.json()};
}
async function probe(env){
  const res=await aiHandler({env,request:new Request("https://tutor.example.net/api/ai",{
    method:"POST",headers:{"Content-Type":"application/json",Authorization:"Bearer "+token(env.AUTH_SECRET)},
    body:JSON.stringify({action:"model_probe",payload:{}})})});
  return {status:res.status,data:await res.json()};
}
test("multiple relays and custom models are stored without exposing raw or encrypted keys",async()=>{
  const {env,storage}=fixture();
  const saved=await saveAIProvider(env.TUTOR_KV,env,{
    name:"Relay A",baseUrl:"https://relay.example.net/v1",models:["gpt-4.1","deepseek-chat"],
    apiKey:"sk-secret-should-not-appear",selectedModel:"deepseek-chat"});
  assert.equal(saved.profiles.length,1);
  assert.equal(saved.profiles[0].hasApiKey,true);
  assert(!JSON.stringify(saved).includes("secret-should-not-appear"));
  assert(!JSON.stringify(saved).includes("encryptedKey"));
  const raw=storage.get("ai_provider_registry_v1");
  assert(!raw.includes("sk-secret-should-not-appear"));
  const result=await activateAIProvider(env.TUTOR_KV,env,saved.profiles[0].id,"gpt-4.1");
  assert.equal(result.activeId,saved.profiles[0].id);
  const resolved=await resolveAIProvider(env.TUTOR_KV,env);
  assert.equal(resolved.model,"gpt-4.1");
  assert.equal(resolved.apiKey,"sk-secret-should-not-appear");
});
test("saved model can be switched without changing API key",async()=>{
  const {env}=fixture();
  const first=await saveAIProvider(env.TUTOR_KV,env,{name:"Relay",baseUrl:"https://relay.example.net/v1",
    models:["model-one","model-two"],apiKey:"sk-persisted"});
  const id=first.profiles[0].id;
  await saveAIProvider(env.TUTOR_KV,env,{id,name:"Relay 2",baseUrl:"https://relay.example.net/v1",
    models:["model-one","model-two","new-custom-model"],selectedModel:"new-custom-model"});
  await activateAIProvider(env.TUTOR_KV,env,id);
  assert.equal((await resolveAIProvider(env.TUTOR_KV,env)).apiKey,"sk-persisted");
  assert.equal((await resolveAIProvider(env.TUTOR_KV,env)).model,"new-custom-model");
});
test("validate relay endpoints against private network and insecure URL attacks",async()=>{
  const {env}=fixture();
  for(const baseUrl of ["http://relay.example.net/v1","https://localhost/v1",
      "https://192.168.1.4/v1","https://[::1]/v1","https://user:pass@relay.example.net/v1",
      "https://relay.example.net/v1?token=secret","https://relay.local/v1"]){
    await assert.rejects(saveAIProvider(env.TUTOR_KV,env,{name:"Bad",baseUrl,models:["gpt-4.1"],apiKey:"secret"}));
  }
  const reg=await loadAIRegistry(env.TUTOR_KV);
  assert.equal(reg.profiles.length,0);
});
test("deleting active relay safely resets selection to environment fallback",async()=>{
  const {env}=fixture();
  const r=await saveAIProvider(env.TUTOR_KV,env,{name:"Relay",baseUrl:"https://relay.example.net/v1",
    models:["gpt-4.1"],apiKey:"key"});
  await activateAIProvider(env.TUTOR_KV,env,r.profiles[0].id);
  const after=await deleteAIProvider(env.TUTOR_KV,env,r.profiles[0].id);
  assert.equal(after.activeId,"env");
  assert.equal((await resolveAIProvider(env.TUTOR_KV,env)).model,"fallback-model");
});
test("admin model actions require login and are not in public GET",async()=>{
  const {env}=fixture();
  const unauth=await store(env,{action:"admin_ai_provider_list"},false);
  assert.equal(unauth.status,401);
  const unauthorizedSave=await store(env,{action:"admin_ai_provider_save",provider:{
    name:"Relay",baseUrl:"https://relay.example.net/v1",models:["gpt-4.1"],apiKey:"secret"}},false);
  assert.equal(unauthorizedSave.status,401);
  const authorized=await store(env,{action:"admin_ai_provider_save",provider:{
    name:"Relay",baseUrl:"https://relay.example.net/v1",models:["gpt-4.1"],apiKey:"secret"}});
  assert.equal(authorized.status,200);
  const publicResponse=await storeHandler({env,request:new Request("https://tutor.example.net/api/store")});
  const publicText=await publicResponse.text();
  assert(!publicText.includes("Relay"));
  assert(!publicText.includes("encryptedKey"));
  assert(!publicText.includes("secret"));
});
test("all AI actions use selected relay API and custom model",async()=>{
  const {env}=fixture();
  const r=await saveAIProvider(env.TUTOR_KV,env,{name:"Relay",baseUrl:"https://relay.example.net/v1",
    models:["deepseek-chat","new-model"],apiKey:"sk-relay-token",selectedModel:"new-model"});
  await activateAIProvider(env.TUTOR_KV,env,r.profiles[0].id);
  const original=globalThis.fetch;let target,model,auth;
  globalThis.fetch=async(url,options)=>{
    target=url;model=JSON.parse(options.body).model;auth=options.headers.Authorization;
    return new Response(JSON.stringify({choices:[{message:{content:'{"health":"ok"}'}}]}),{status:200});
  };
  try {
    const response=await probe(env);
    assert.equal(response.status,200);
    assert.equal(response.data.result.health,"ok");
    assert.equal(target,"https://relay.example.net/v1/chat/completions");
    assert.equal(model,"new-model");
    assert.equal(auth,"Bearer sk-relay-token");
    assert(!JSON.stringify(response.data).includes("sk-relay-token"));
  }finally{globalThis.fetch=original;}
});
test("changing AUTH_SECRET makes encrypted key unreadable instead of leaking or using wrong model",async()=>{
  const {env}=fixture();
  const r=await saveAIProvider(env.TUTOR_KV,env,{name:"Relay",baseUrl:"https://relay.example.net/v1",
    models:["gpt-4.1"],apiKey:"old-secret"});
  await activateAIProvider(env.TUTOR_KV,env,r.profiles[0].id);
  await assert.rejects(resolveAIProvider(env.TUTOR_KV,{...env,AUTH_SECRET:"different-secret"}),/解密/);
});
