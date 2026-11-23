// Admin-only, browser-memory historical import wizard. Nothing is published automatically.
import { readWechatFiles } from './wechat-bulk-reader.js';
import { splitWechatMessages, redactWechatText, normalizeImportDocuments,
  groupWechatMessages, findBulkDuplicate, safeBulkUpdates } from './wechat-bulk-core.js';
import { parseBulkWechatMessages } from './ai-engine.js';
import { normalizeOrder, formatOrderText, parseFormattedOrder } from './order-format.js';
import { checkDraftIds, missingDraftFields } from './draft-grouping.js';

const state = {
  docs:[], messages:[], batches:[], drafts:[], updates:[], warnings:[],
  pastedText:'', consent:false, running:false, stopping:false, publishing:false,
  error:'', filter:'all', shown:30, report:[]
};
let root = null, deps = null;
const esc = s => String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;')
  .replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
function existing() { return deps.Store.getOrders(); }
function reserved() {
  return [...existing(), ...state.drafts.map(d=>d.order),
    {orderNumber:'#'+deps.Store.getOrderSequence()}];
}
function refreshMessages() {
  state.messages = normalizeImportDocuments(state.docs);
  state.batches = groupWechatMessages(state.messages);
  state.drafts = []; state.updates = []; state.report = [];
  state.error = ''; state.shown = 30;
}
function sourcesFor(batch, indices) {
  const valid = [...new Set(indices || [])].filter(n=>Number.isInteger(n) && n>=1 && n<=batch.messages.length);
  return (valid.length ? valid.map(n=>batch.messages[n-1]) : batch.messages).map(m=>({
    source:m.source, text:m.text, index:m.index
  }));
}
function duplicateFor(item) {
  return findBulkDuplicate(item.order, [
    ...existing(), ...state.drafts.slice(0, state.drafts.indexOf(item)).filter(x=>!x.published).map(x=>x.order)
  ]);
}
function validToPublish(item) {
  const o = item.order, dup = duplicateFor(item);
  return !item.published && !item.failed &&
    !(!o?.grade || /待补充/.test(o.grade) || !o?.subject || /待补充/.test(o.subject)) &&
    !(dup?.hard) && !(dup && !item.allowSimilar);
}
function progressText() {
  const pending = state.batches.filter(b=>b.status==='pending').length;
  const success = state.batches.filter(b=>b.status==='done').length;
  const failed = state.batches.filter(b=>b.status==='failed').length;
  return success + ' 批成功 · ' + failed + ' 批失败 · ' + pending + ' 批待处理';
}
function countSelection() {
  return state.drafts.filter(x=>x.selected && validToPublish(x)).length;
}
function visibleDrafts() {
  const items = state.drafts.filter(item=>{
    const dup = duplicateFor(item);
    if(state.filter==='duplicates') return !!dup;
    if(state.filter==='ready') return !dup && !item.published;
    if(state.filter==='published') return !!item.published;
    return true;
  });
  return {items, total:items.length};
}
function render() {
  if (!root) return;
  const visible = visibleDrafts();
  const failures = state.batches.filter(b=>b.status==='failed');
  const status = state.running ? 'AI 正在依次处理，请保持此页面打开…' :
    state.publishing ? '正在逐批写入云端…' : progressText();
  const locked = state.running || state.publishing;
  root.innerHTML = '<div class="bulk-intro"><h2>📥 微信历史家教单 · 批量导入</h2>'+
    '<p>多选文件或粘贴微信聊天记录 → 本地分离消息 → AI 分批拆单/识别状态更新 → 检查重复 → 人工审核后保存。历史订单一律默认关闭展示，不会直接出现在老师端。</p></div>'+
    '<div class="bulk-import-grid"><section class="bulk-panel">'+
    '<h3>① 导入来源</h3><label class="bulk-file-drop" id="bulkDrop" tabindex="0" for="bulkFiles">'+
    '<strong>📁 点击或拖入多个文件</strong><small>TXT · ZIP · JSON · CSV / TSV · DOCX · XLSX</small></label>'+
    '<input id="bulkFiles" type="file" multiple accept=".txt,.zip,.json,.csv,.tsv,.docx,.xlsx" '+
    (locked?'disabled':'')+' />'+
    '<label for="bulkPaste">也可直接粘贴多条微信消息（空行、消息时间或 #单号作为分隔）</label>'+
    '<textarea id="bulkPaste" rows="4" placeholder="#2811/高三生物家教…&#10;&#10;#2861/高一化学生物家教…" '+
    (locked?'disabled':'')+'></textarea>'+
    '<div class="bulk-toolbar"><button class="btn btn-sm" id="bulkAddPaste" '+(locked?'disabled':'')+'>添加粘贴消息</button>'+
    '<button class="btn btn-sm" id="bulkReset" '+(locked?'disabled':'')+'>清空本次导入</button></div>'+
    '<p class="bulk-mini">'+state.docs.length+' 份来源 · '+state.messages.length+' 条独立消息 · '+state.batches.length+' 个处理批次</p>'+
    (state.warnings.length?'<details><summary>文件提醒（'+state.warnings.length+'）</summary><ul>'+state.warnings.slice(0,20).map(w=>'<li>'+esc(w)+'</li>').join('')+'</ul></details>':'')+
    '</section><section class="bulk-panel"><h3>② AI 分批识别</h3>'+
    '<p>上传文件由本地浏览器读取。只有勾选授权后，系统才会将脱敏后的文字发送至你已配置的第三方 AI 服务。</p>'+
    '<label class="bulk-consent"><input type="checkbox" id="bulkConsent" '+(state.consent?'checked':'')+' '+(locked?'disabled':'')+' />'+
    '确认有权处理这些消息，并同意发送脱敏文字至已配置的 AI API</label>'+
    '<div class="bulk-toolbar"><button class="btn btn-primary" id="bulkRun" '+(locked||!state.messages.length?'disabled':'')+'>'+
    '✨ 开始 / 继续识别</button><button class="btn btn-sm" id="bulkRetry" '+(locked||!failures.length?'disabled':'')+'>'+
    '重试失败批次（'+failures.length+'）</button>'+
    (state.running?'<button class="btn btn-sm" id="bulkStop">本批结束后暂停</button>':'')+'</div>'+
    '<p role="status" aria-live="polite" class="bulk-mini">'+esc(status)+'</p>'+
    '<div class="bulk-progress"><div style="width:'+(state.batches.length?
      Math.round(state.batches.filter(b=>b.status==='done').length/state.batches.length*100):0)+'%"></div></div>'+
    (failures.length?'<details><summary>查看失败原因</summary><ol>'+failures.slice(0,25).map(b=>
      '<li>'+esc(b.messages.map(x=>x.source).slice(0,2).join('、'))+'：'+esc(b.error)+'</li>').join('')+'</ol></details>':'')+
    '<p class="bulk-mini">每批最多 10 条消息 / 9000 字符；API 失败保留当前页面的成功结果，不会回退到本地假 AI。</p>'+
    '</section></div>'+
    '<section class="bulk-panel bulk-review"><div class="bulk-review-heading"><div><h3>③ 审核草稿与去重</h3>'+
    '<p>'+state.drafts.length+' 张草稿 · '+state.drafts.filter(x=>duplicateFor(x)).length+' 条疑似重复 · '+
    state.updates.length+' 条状态更新建议 · '+countSelection()+' 张待保存</p></div>'+
    '<div class="bulk-toolbar"><select id="bulkFilter" aria-label="筛选导入草稿">'+
    [['all','全部草稿'],['ready','非重复草稿'],['duplicates','疑似重复'],['published','已保存']].map(p=>
      '<option value="'+p[0]+'" '+(state.filter===p[0]?'selected':'')+'>'+p[1]+'</option>').join('')+'</select>'+
    '<button class="btn btn-sm" id="bulkSelectReady" '+(locked?'disabled':'')+'>勾选非重复</button>'+
    '<button class="btn btn-sm" id="bulkClearSelection" '+(locked?'disabled':'')+'>取消勾选</button></div></div>'+
    (state.report.length?'<details><summary>AI 核查备注（'+state.report.length+'）</summary><ul>'+
      state.report.slice(0,40).map(x=>'<li>'+esc(x)+'</li>').join('')+'</ul></details>':'')+
    (!visible.total?'<p class="bulk-mini">识别完成后，草稿会在这里出现。导入历史单并不会自动发布。</p>':'')+
    visible.items.slice(0,state.shown).map((item)=>{
      const dupe=duplicateFor(item), missing=missingDraftFields(item.order), eligible=validToPublish(item);
      const origin=item.sources || [];
      return '<article class="bulk-draft">'+
        '<div class="bulk-draft-head"><label><input type="checkbox" data-bulk-select="'+esc(item.key)+'" '+
        (item.selected?'checked ':'')+(!eligible||locked?'disabled ':'')+' />'+
        '<strong>'+esc(item.order.orderNumber||item.order.id)+'</strong> · '+esc(item.order.grade)+' '+esc(item.order.subject)+'</label>'+
        '<span class="bulk-status '+(item.published?'bulk-done':dupe?'bulk-alert':'')+'">'+
        (item.published?'已保存':dupe?'疑似重复':'待审核 · 默认不展示')+'</span></div>'+
        (dupe?'<p class="bulk-warning">⚠ '+esc(dupe.reason)+'：'+esc(dupe.id)+
          (dupe.hard?'（单号冲突，禁止重复创建）':'（请核实是否不同学生）')+'</p>':'')+
        (dupe&&!dupe.hard&&!item.published?'<label class="bulk-mini"><input type="checkbox" data-bulk-override="'+
          esc(item.key)+'" '+(item.allowSimilar?'checked':'')+' '+(locked?'disabled':'')+
          ' />已人工确认是不同学生，允许保留此相似单</label>':'')+
        (missing.length?'<p class="bulk-warning">待核对：'+esc(missing.join('、'))+'</p>':'')+
        '<textarea aria-label="编辑 '+esc(item.order.id)+' 草稿" data-bulk-edit="'+esc(item.key)+'" rows="9" '+
        (item.published||locked?'disabled':'')+'>'+esc(formatOrderText(item.order))+'</textarea>'+
        '<details><summary>查看来源微信消息（'+origin.length+' 条）</summary>'+
        origin.slice(0,12).map(x=>'<div class="bulk-source"><strong>'+esc(x.source)+'</strong><pre>'+esc(x.text.slice(0,2800))+'</pre></div>').join('')+'</details>'+
        '<p class="bulk-mini">修改内容后点击其他位置即可更新草稿；原始微信消息不会随订单保存。</p></article>';
    }).join('')+
    (visible.total>state.shown?'<button class="btn btn-sm" id="bulkMore">继续显示 '+Math.min(30,visible.total-state.shown)+' 条</button>':'')+
    '<div class="bulk-publish-bar"><span>已勾选 '+countSelection()+' 张 · <strong>保存后保持关闭展示</strong></span>'+
    '<button class="btn btn-primary" id="bulkPublish" '+(locked||!countSelection()?'disabled':'')+'>保存已选草稿（'+countSelection()+'）</button></div></section>'+
    '<section class="bulk-panel"><h3>④ 历史消息中的状态更新</h3>'+
    '<p>例如「#2811 招满了」，仅对确实存在、原文包含该单号的订单提供修改建议，必须单独确认，不会自动覆盖。</p>'+
    (state.updates.length?state.updates.map((x,i)=>
      '<label class="bulk-update"><input type="checkbox" data-bulk-update="'+i+'" '+
      (x.selected?'checked':'')+' '+(!x.verified||x.done||locked?'disabled':'')+' />'+
      '<span><strong>'+esc(x.id)+'</strong> → '+esc(x.status)+' '+(x.done?'（已应用）':x.verified?'':'（无法核对，未启用）')+
      '<small>'+esc(x.note || x.source.slice(0,160))+'</small></span></label>').join(''):
      '<p class="bulk-mini">尚无需要处理的状态更新。</p>')+
    '<button class="btn btn-sm" id="bulkApplyUpdates" '+(locked||!state.updates.some(x=>x.selected&&x.verified&&!x.done)?'disabled':'')+
    '>确认应用勾选的状态变更</button></section>'+
    (state.error?'<p class="bulk-warning" role="alert">'+esc(state.error)+'</p>':'')+
    '<p class="bulk-mini">隐私提示：整批消息仅暂存在当前网页内存，刷新页面会清空未发布的处理结果。建议先小批测试并对照原微信核验。</p>';
  bind();
}
function bind() {
  const find = id => root.querySelector('#'+id);
  find('bulkPaste').value = state.pastedText;
  find('bulkPaste').oninput = e=>{state.pastedText=e.target.value;};
  find('bulkFiles').onchange = e=>{ void addFiles(e.target.files); };
  const drop = find('bulkDrop');
  drop.ondragover = e=>{e.preventDefault();drop.classList.add('bulk-drop-active');};
  drop.ondragleave = ()=>drop.classList.remove('bulk-drop-active');
  drop.ondrop = e=>{e.preventDefault();drop.classList.remove('bulk-drop-active');void addFiles(e.dataTransfer?.files);};
  find('bulkConsent').onchange=e=>{state.consent=e.target.checked;};
  find('bulkAddPaste').onclick=()=>{
    if (!state.pastedText.trim()) return deps.toast('请先粘贴微信消息');
    if (!mayReplace()) return;
    state.docs.push({name:'手动粘贴 '+(state.docs.length+1),
      messages:splitWechatMessages(state.pastedText,'手动粘贴 '+(state.docs.length+1))});
    state.pastedText = '';state.consent=false;
    try{refreshMessages();render();}catch(error){state.error=error.message;render();}
  };
  find('bulkReset').onclick=()=>{
    if(!state.docs.length || confirm('确定清空本次尚未发布的历史导入数据？已经保存的订单不会被删除。')){
      Object.assign(state,{docs:[],messages:[],batches:[],drafts:[],updates:[],warnings:[],
        pastedText:'',consent:false,error:'',report:[],shown:30});render();
    }
  };
  find('bulkRun').onclick=()=>{void process(false);};
  find('bulkRetry').onclick=()=>{void process(true);};
  find('bulkStop')?.addEventListener('click',()=>{
    state.stopping=true;find('bulkStop').disabled=true;find('bulkStop').textContent='本批结束后暂停中';
  });
  find('bulkFilter').onchange=e=>{state.filter=e.target.value;state.shown=30;render();};
  find('bulkSelectReady').onclick=()=>{
    state.drafts.forEach(x=>{x.selected=validToPublish(x)&&!duplicateFor(x);});render();
  };
  find('bulkClearSelection').onclick=()=>{state.drafts.forEach(x=>{x.selected=false;});render();};
  find('bulkMore')?.addEventListener('click',()=>{state.shown+=30;render();});
  root.querySelectorAll('[data-bulk-select]').forEach(input=>input.onchange=()=>{
    const item=state.drafts.find(x=>x.key===input.dataset.bulkSelect);
    if(item){item.selected=input.checked&&validToPublish(item);render();}
  });
  root.querySelectorAll('[data-bulk-override]').forEach(input=>input.onchange=()=>{
    const item=state.drafts.find(x=>x.key===input.dataset.bulkOverride);
    if(item){item.allowSimilar=input.checked;item.selected=false;render();}
  });
  root.querySelectorAll('[data-bulk-edit]').forEach(input=>input.onchange=()=>{
    const item=state.drafts.find(x=>x.key===input.dataset.bulkEdit);
    if (!item) return;
    const parsed=parseFormattedOrder(input.value);
    if(!parsed){deps.toast('九字段格式未识别，请保留标准字段标签');return;}
    item.order=normalizeOrder({...item.order,...parsed,
      id:parsed.id||item.order.id,orderNumber:parsed.id||item.order.id,
      status:'已匹配',source:'wechat-history'});
    item.selected=false;
    render();
  });
  root.querySelectorAll('[data-bulk-update]').forEach(input=>input.onchange=()=>{
    const item=state.updates[Number(input.dataset.bulkUpdate)];
    if(item){item.selected=input.checked;render();}
  });
  find('bulkPublish').onclick=()=>{void publishSelected();};
  find('bulkApplyUpdates').onclick=()=>{void applyUpdates();};
}
function mayReplace() {
  return !(state.drafts.some(x=>!x.published)||state.batches.some(x=>x.status==='done')) ||
    confirm('添加来源将清空本次未发布的 AI 草稿和进度，确定继续？');
}
async function addFiles(files) {
  if(!files?.length || state.running || state.publishing || !mayReplace())return;
  try {
    const parsed=await readWechatFiles(files);
    if(!parsed.documents.length && parsed.warnings.length)throw new Error(parsed.warnings.join('；'));
    state.docs.push(...parsed.documents);
    state.consent=false;
    state.warnings.push(...parsed.warnings);
    refreshMessages();render();
    deps.toast('已本地读取 '+parsed.documents.length+' 份文档，共 '+state.messages.length+' 条消息');
  }catch(err){state.error='读取文件失败：'+err.message;render();}
}
async function process(retryOnly) {
  if(state.running || state.publishing)return;
  if(!state.consent){state.error='请先确认已获得处理授权，并同意发送脱敏文字至 AI API';render();return;}
  if(!state.messages.length)return;
  state.running=true;state.stopping=false;state.error='';render();
  try {
    for(let i=0;i<state.batches.length;i++){
      const batch=state.batches[i];
      if(state.stopping)break;
      if(retryOnly ? batch.status!=='failed' : batch.status!=='pending')continue;
      if(batch.messages.some(x=>redactWechatText(x.text).length>9000))continue;
      batch.status='working';batch.error='';render();
      try {
        const redacted=batch.messages.map((x,n)=>({source:'本批消息 '+(n+1),text:redactWechatText(x.text)}));
        const result=await parseBulkWechatMessages(redacted,reserved());
        const before=state.drafts.length;
        for(let j=0;j<result.orders.length;j++){
          const o=result.orders[j];
          const sourceItems=sourcesFor(batch,o.sourceMessageIndices);
          const order=normalizeOrder({...o,source:'wechat-history',status:'已匹配'});
          const item={key:'b'+i+'o'+j,order,sources:sourceItems,selected:false,
            published:false,failed:false,allowSimilar:false};
          const duplicate=findBulkDuplicate(order,[...existing(),...state.drafts.map(d=>d.order)]);
          item.selected=!duplicate && !/待补充/.test(order.grade) && !/待补充/.test(order.subject);
          state.drafts.push(item);
        }
        // Message indices here refer to the local 1-based index within this API batch.
        const updates=safeBulkUpdates(result.updates,
          redacted.map((x,n)=>({...x,index:n+1})),existing());
        for(const item of updates)if(!state.updates.some(x=>x.id===item.id&&x.status===item.status&&x.source===item.source))
          state.updates.push(item);
        for(const note of result.questions || [])state.report.push('第'+(i+1)+'批待核实：'+note);
        for(const note of result.groupingNotes || [])state.report.push('第'+(i+1)+'批拆合说明：'+note);
        if(!result.orders.length && !result.updates.length)state.report.push('第'+(i+1)+'批未识别到可导入家教单');
        batch.status='done';
        batch.created=state.drafts.length-before;
      }catch(error){batch.status='failed';batch.error=error.message;state.error='第'+(i+1)+'批失败：'+error.message;}
      render();
    }
  } finally {
    state.running=false;state.stopping=false;render();
    deps.toast(progressText()+' · 已生成 '+state.drafts.length+' 张草稿');
  }
}
async function publishSelected() {
  if(state.running||state.publishing)return;
  const chosen=state.drafts.filter(x=>x.selected && validToPublish(x));
  if(!chosen.length)return;
  const orders=chosen.map(x=>normalizeOrder({...x.order,source:'wechat-history',status:'已匹配'}));
  const issues=checkDraftIds(orders,existing());
  if(issues.length){state.error='不能保存：单号不合法或冲突：'+issues.slice(0,4).join('、');render();return;}
  if(!confirm('确认保存 '+chosen.length+' 张历史家教单到云端？\\n\\n这些单均为「已匹配 / 关闭展示」，不会自动对老师公开。请核实后再逐条重新上架。'))return;
  state.publishing=true;state.error='';render();
  let success=0;
  try {
    for(let i=0;i<chosen.length;i+=40){
      const batch=chosen.slice(i,i+40);
      try {
        await deps.Store.addOrders(batch.map(x=>normalizeOrder({...x.order,status:'已匹配',source:'wechat-history'})));
        batch.forEach(x=>{x.published=true;x.selected=false;});
        success+=batch.length;
      }catch(error){state.error='第'+(1+Math.floor(i/40))+'组保存失败：'+error.message+
          '；已成功保存 '+success+' 张，其他草稿仍在当前页面，可重新勾选重试。';break;}
    }
  }finally{
    state.publishing=false;render();
    deps.refresh();
    deps.toast('已保存 '+success+' 张历史单（默认关闭展示）');
  }
}
async function applyUpdates() {
  const selected=state.updates.filter(x=>x.selected&&x.verified&&!x.done);
  if(!selected.length||state.running||state.publishing)return;
  if(!confirm('确定对现有 '+selected.length+' 张订单应用状态更新？请先核对原始消息、单号和最新招募情况。'))return;
  state.publishing=true;render();
  let count=0;
  try{
    for(const item of selected){
      try{
        await deps.Store.updateOrder(item.internalId,{status:item.status});
        item.done=true;item.selected=false;count++;
      }catch(err){state.error='更新 '+item.id+' 失败：'+err.message;break;}
    }
  }finally{
    state.publishing=false;render();deps.refresh();
    deps.toast('已确认更新 '+count+' 张家教单');
  }
}
export function mountWechatBulkImport(container, callbacks) {
  root=container;deps=callbacks;render();
}
