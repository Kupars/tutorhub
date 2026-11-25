// Administrator-only model management. API keys are never cached or echoed back.
import { probeAIProvider } from "./ai-engine.js?v=16";
let root, Store, toast, registry, editingId=null, notice="", busy=false;
const esc=s=>String(s??"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;");
function activeLabel(){
  if(!registry)return "正在读取配置";
  if(registry.activeId==="env")return registry.envConfigured ? registry.envProvider+" · "+registry.envModel : "未配置";
  const p=registry.profiles.find(x=>x.id===registry.activeId);
  return p ? p.name+" · "+p.selectedModel : "配置不存在";
}
function providerCard(p){
  const isActive=p.id===registry.activeId;
  return '<div class="ai-provider-card"><div class="ai-provider-info"><strong>'+esc(p.name)+'</strong>'+
    (isActive?'<span class="ai-provider-current">当前启用</span>':'')+
    '<p class="admin-helper">'+esc(p.baseUrl)+'</p><p class="admin-helper">已添加 '+p.models.length+' 个模型 · API Key：'+(p.hasApiKey?'已保存':'未配置')+'</p>'+
    '<label>选择模型 <select data-model-select="'+esc(p.id)+'" '+(busy?'disabled':'')+'>'+
    p.models.map(m=>'<option value="'+esc(m)+'" '+(m===p.selectedModel?'selected':'')+'>'+esc(m)+'</option>').join('')+
    '</select></label></div><div class="ai-provider-actions">'+
    '<button type="button" class="btn btn-sm '+(isActive?'btn-primary':'')+'" data-activate="'+esc(p.id)+'" '+(busy?'disabled':'')+'>'+(isActive?'应用所选模型':'切换使用')+'</button>'+
    '<button type="button" class="btn btn-sm" data-test="'+esc(p.id)+'" '+(busy?'disabled':'')+'>测试连接</button>'+
    '<button type="button" class="btn btn-sm" data-fallback="'+esc(p.id)+'" '+(busy?'disabled':'')+'>设为备用</button>'+
    '<button type="button" class="btn btn-sm" data-edit="'+esc(p.id)+'" '+(busy?'disabled':'')+'>编辑</button>'+
    '<button type="button" class="btn btn-danger btn-sm" data-delete="'+esc(p.id)+'" '+(busy?'disabled':'')+'>删除</button></div></div>';
}
function render(){
  if(!root)return;
  if(!registry){root.innerHTML='<div class="panel"><h2>AI 模型管理</h2><p class="admin-helper">'+esc(notice||'正在读取配置…')+'</p><button id="retryModels" class="btn btn-sm">重试</button></div>';
    root.querySelector('#retryModels').onclick=refresh;return;}
  const current=registry.profiles.find(p=>p.id===editingId);
  root.innerHTML='<div class="panel ai-model-manager">'+
    '<div class="ai-model-top"><div><h2>🧠 AI 模型与中转站管理</h2><p class="admin-helper">支持多个 OpenAI 兼容的 HTTPS 中转站，每个中转站都能保存多个自定义模型 ID。</p></div>'+
    '<button class="btn btn-sm" type="button" id="refreshModels" '+(busy?'disabled':'')+'>刷新</button></div>'+
    '<div class="ai-model-active"><span>当前全站 AI</span><strong>'+esc(activeLabel())+'</strong></div>'+
    '<p class="admin-helper">新请求统一使用所选模型：录单、AI 修改、老师智能推荐和简历识别。</p>'+
    '<div class="ai-provider-card"><div><strong>备用模型：'+esc(registry.fallbackId?(registry.fallbackId==='env'?'默认模型':(registry.profiles.find(p=>p.id===registry.fallbackId)?.name||'')+' / '+registry.fallbackModel):'未启用')+'</strong><p class="admin-helper">只在管理员录单或修改请求早期出现网络/网关错误时切换一次；不自动转发简历或公开推荐请求。</p></div><button class="btn btn-sm" id="disableFallback" '+(!registry.fallbackId||busy?'disabled':'')+'>关闭备用</button><button class="btn btn-sm" id="fallbackEnv" '+(!registry.envConfigured||busy?'disabled':'')+'>默认模型作备用</button></div>'+
    '<details><summary>近期模型调用统计</summary><button class="btn btn-sm" id="loadAIMetrics">读取统计</button><div id="aiMetricsOutput" class="admin-helper"></div><p class="admin-helper">仅记录管理员调用、耗时及服务商返回的 token 用量，不保存提示词或密钥。统计为尽力记录，不估算未知费用。</p></details>'+
    (notice?'<p class="ai-model-notice" role="status">'+esc(notice)+'</p>':'')+
    '<div class="ai-provider-card"><div><strong>Cloudflare 默认模型</strong><p class="admin-helper">'+esc(registry.envProvider)+' · '+esc(registry.envModel||'未配置')+'</p></div>'+
    '<button type="button" id="activateEnv" class="btn btn-sm" '+(busy||!registry.envConfigured?'disabled':'')+'>切换到默认</button></div>'+
    registry.profiles.map(providerCard).join('')+
    '<section class="ai-model-editor"><h3>'+ (current?'编辑中转站':'添加中转站')+'</h3>'+
    '<form id="aiModelForm" class="ai-model-fields">'+
    '<div class="field"><label for="aiRelayName">中转站名称</label><input id="aiRelayName" required maxlength="60" value="'+esc(current?.name||'')+'" placeholder="例如：灵域 API / 硅基流动" /></div>'+
    '<div class="field"><label for="aiRelayUrl">API 根地址（HTTPS）</label><input id="aiRelayUrl" type="url" required maxlength="350" value="'+esc(current?.baseUrl||'')+'" placeholder="https://api.example.com/v1" /></div>'+
    '<div class="field"><label for="aiRelayKey">API Key'+(current?'（留空保留原密钥）':'（必填）')+'</label>'+
    '<input id="aiRelayKey" type="password" autocomplete="new-password" spellcheck="false" '+(current?'':'required')+' placeholder="'+(current?'已保存，留空不修改':'sk-...')+'"/><small>仅在保存时发送给本站后台，服务端加密存储，不会回显。</small></div>'+
    '<div class="field"><label for="aiRelayModels">模型名称 / Model ID（每行一个）</label>'+
    '<textarea id="aiRelayModels" rows="5" required spellcheck="false" placeholder="gpt-4.1&#10;deepseek-chat&#10;gemini-2.5-pro">'+esc(current?.models.join('\n')||'')+'</textarea>'+
    '<small>可直接输入中转站支持的任意新模型 ID；不会自动检测模型是否收费。</small></div>'+
    '<div class="ai-provider-actions"><button class="btn btn-primary" type="submit" '+(busy?'disabled':'')+'>'+(current?'保存修改':'添加中转站')+'</button>'+
    '<button type="button" class="btn btn-sm" id="cancelModelEdit" '+(busy?'disabled':'')+'>'+(current?'取消编辑':'清空')+'</button></div></form></section>'+
    '<p class="admin-helper">API 地址请填写包含 /v1 的基础路径，系统自动添加 /chat/completions。测试连接会发生一次实际调用并可能产生费用。更换 AUTH_SECRET 后，原先加密保存的 API Key 需要重新填写。</p></div>';
  bind();
}
async function operation(call,message){
  if(busy)return;
  busy=true;notice='正在处理…';render();
  try{
    const result=await call();if(result?.profiles)registry=result;
    notice=message;toast(message);
  }catch(error){notice='操作失败：'+error.message;toast(notice);}
  finally{busy=false;render();}
}
function chosenModel(id){return root.querySelector('[data-model-select="'+id+'"]')?.value||registry.profiles.find(p=>p.id===id)?.selectedModel;}
function bind(){
  root.querySelector('#refreshModels').onclick=refresh;
  const setFallback=(id,model)=>{if(id&&!confirm('启用后，符合条件的失败请求可能将录单内容发送给备用模型服务商并产生费用。确认启用？'))return;void operation(()=>Store.setAIProviderFallback(id,model),id?'备用模型已设置':'已关闭备用模型');};
  root.querySelector('#disableFallback').onclick=()=>setFallback('','');
  root.querySelector('#fallbackEnv').onclick=()=>setFallback('env','');
  root.querySelectorAll('[data-fallback]').forEach(b=>b.onclick=()=>setFallback(b.dataset.fallback,chosenModel(b.dataset.fallback)));
  root.querySelector('#loadAIMetrics').onclick=async()=>{const node=root.querySelector('#aiMetricsOutput');node.textContent='正在读取…';try{const entries=await Store.getAIMetrics(),groups=new Map();for(const e of entries||[]){const g=groups.get(e.provider)||{total:0,ok:0,ms:0,tokens:0,known:0};g.total++;g.ok+=e.ok?1:0;g.ms+=Number(e.ms)||0;if(Number.isFinite(e.tokens)){g.tokens+=e.tokens;g.known++;}groups.set(e.provider,g);}node.replaceChildren();if(!groups.size)node.textContent='暂无记录';for(const [name,g] of groups){const row=document.createElement('p');row.textContent=name+' · '+g.ok+'/'+g.total+' 成功 · 平均 '+Math.round(g.ms/g.total)+'ms · '+(g.known?g.tokens+' tokens（'+g.known+'次有用量）':'用量未知');node.append(row);}}catch(e){node.textContent=e.message;}};
  root.querySelector('#activateEnv').onclick=()=>operation(()=>Store.activateAIProvider('env'),'已切换到 Cloudflare 默认模型');
  root.querySelectorAll('[data-activate]').forEach(b=>b.onclick=()=>{
    const id=b.dataset.activate,model=chosenModel(id);
    void operation(()=>Store.activateAIProvider(id,model),'已启用模型：'+model);
  });
  root.querySelectorAll('[data-test]').forEach(b=>b.onclick=()=>{
    const id=b.dataset.test,profile=registry.profiles.find(p=>p.id===id),model=chosenModel(id);
    void operation(async()=>{const result=await probeAIProvider(id,model);if(!result.ok)throw new Error(result.error);},
      '模型连接成功：'+profile.name+' / '+model);
  });
  root.querySelectorAll('[data-edit]').forEach(b=>b.onclick=()=>{
    editingId=b.dataset.edit;notice='';render();root.querySelector('#aiRelayName')?.focus();
  });
  root.querySelectorAll('[data-delete]').forEach(b=>b.onclick=()=>{
    const id=b.dataset.delete,p=registry.profiles.find(x=>x.id===id);
    if(!confirm('删除中转站「'+p.name+'」及已保存的 API Key？此操作不可撤销。'))return;
    void operation(async()=>{const next=await Store.deleteAIProvider(id);editingId=null;return next;},'已删除中转站');
  });
  root.querySelector('#cancelModelEdit').onclick=()=>{editingId=null;notice='';render();};
  root.querySelector('#aiModelForm').onsubmit=e=>{
    e.preventDefault();
    const name=root.querySelector('#aiRelayName').value.trim();
    const baseUrl=root.querySelector('#aiRelayUrl').value.trim();
    const apiKey=root.querySelector('#aiRelayKey').value.trim();
    const models=root.querySelector('#aiRelayModels').value.split(/[\r\n,，]+/).map(x=>x.trim()).filter(Boolean);
    const original=registry.profiles.find(p=>p.id===editingId);
    const selectedModel=original&&models.includes(original.selectedModel)?original.selectedModel:models[0];
    const id=editingId;
    void operation(async()=>{const next=await Store.saveAIProvider({...(id?{id}:{}),name,baseUrl,apiKey,models,selectedModel});
      editingId=null;return next;},'中转站已保存，点击「切换使用」后生效');
  };
}
async function refresh(){
  if(busy)return;
  busy=true;notice='正在读取配置…';render();
  try{registry=await Store.listAIProviders();notice='';}
  catch(e){notice='加载失败：'+e.message;toast(notice);}
  finally{busy=false;render();}
}
export function mountAIModelManager(container,callbacks){
  root=container;Store=callbacks.Store;toast=callbacks.toast;
  void refresh();
}
