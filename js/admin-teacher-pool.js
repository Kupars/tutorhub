import { callServerlessAI } from "./ai-engine.js?v=7";
import { ageOfOpenOrder } from "./assignment-utils.js";
import { recommendTeacherProfiles, TEACHER_AVAILABILITIES, TEACHER_GENDERS, wantedTeacherGender } from "./teacher-profile-utils.js?v=2";

let activeOrderId="";
let editingTeacherId="";
let teacherQuery="";
let latestExtraction="";
let autoLinkOrderId="";
let resumeInput="";
const h = v=>String(v??"").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;");
const short=(v,n=80)=>String(v||"").slice(0,n);
const opts=(values,selected)=>values.map(x=>`<option value="${h(x)}" ${selected===x?"selected":""}>${h(x)}</option>`).join("");
const showOrderName=o=>h(o.orderNumber||o.id)+" · "+h(o.grade||"")+h(o.subject||"");

export function renderTeacherPool(orders,profiles,applications,legacyAssignments,cloudReady) {
  const active=orders.find(o=>o.id===activeOrderId);
  const editing=profiles.find(p=>p.id===editingTeacherId);
  const matched=active?recommendTeacherProfiles(active,profiles,applications,orders,legacyAssignments,8):[];
  const linked=applications.filter(c=>c.orderId===activeOrderId);
  const available=profiles.filter(p=>p.availability==="可接单").length;
  const overdue=orders.map(o=>({order:o,age:ageOfOpenOrder(o)}))
    .filter(x=>x.age?.kind==="overdue").sort((a,b)=>b.age.days-a.age.days);
  const list=profiles.filter(p=>(p.name+" "+p.school+" "+p.canTeach+" "+p.preferredDistricts+" "+p.agentName)
    .toLowerCase().includes(teacherQuery.toLowerCase())).slice(0,80);
  return `<section class="panel teacher-pool-panel" id="teacherPoolPanel">
    <h2>👨‍🏫 老师档案库与定向推荐</h2>
    <p class="admin-helper">老师可以先入库、暂时不投递任何单子；一条单也能登记多个投递老师。投递记录和老师状态不会自动更改订单上下架。</p>
    ${!cloudReady?'<p class="admin-helper ai-draft-warning">需要 Cloudflare KV 和管理员登录才能存储老师私人档案。</p>':""}
    <div class="assignment-stats">
      <span><strong>${profiles.length}</strong> 位储备老师</span>
      <span><strong>${available}</strong> 位标记可接单</span>
      <span><strong>${applications.length}</strong> 条投递记录</span>
      <span><strong>${overdue.length}</strong> 条超10天待跟进</span>
    </div>
    <div class="teacher-pool-layout">
      <div class="teacher-profile-editor" id="teacherProfileEditor">
        <h3>${editing?"编辑老师 · "+h(editing.name):"新增储备老师（无需对应订单）"}</h3>
        <div class="field">
          <label for="teacherResumeText">粘贴老师简历 / 自荐文字（可选）</label>
          <textarea id="teacherResumeText" rows="3" placeholder="直接粘贴简历，或写：姓名张某，天津大学在读，男老师，可带数学物理。不必包含微信、手机号。">${h(resumeInput)}</textarea>
        </div>
        <div class="teacher-resume-actions">
          <input type="file" id="teacherResumeFile" accept=".txt,.md,.jpg,.jpeg,.png,.webp,text/plain,image/png,image/jpeg,image/webp" aria-label="上传老师简历图片或文本文件"/>
          <button type="button" id="teacherAIExtract" class="btn btn-sm">✨ AI 提取姓名 / 学校 / 性别 / 科目</button>
        </div>
        <p class="admin-helper">仅支持 TXT、Markdown、JPG、PNG、WebP，暂不直接解析 PDF/Word，请复制其文字或上传截图。图片需由当前 API 模型支持视觉；AI 不提取联系方式。简历内容将发送给已配置的第三方 API，建议先移除不必要的敏感信息，不保留简历原文件。</p>
        <div id="teacherExtractResult" class="admin-helper">${h(latestExtraction)}</div>
        <form id="teacherProfileForm" class="assignment-form">
          <div class="field"><label for="teacherName">姓名 / 称呼 *</label><input id="teacherName" required maxlength="80" value="${h(editing?.name||"")}" placeholder="手动核对 AI 识别结果"/></div>
          <div class="field"><label for="teacherSchool">学校 / 任职单位</label><input id="teacherSchool" maxlength="120" value="${h(editing?.school||"")}" placeholder="天津大学、专职教师任职单位等"/></div>
          <div class="field"><label for="teacherGender">老师性别</label><select id="teacherGender">${opts(TEACHER_GENDERS,editing?.gender||"未知")}</select></div>
          <div class="field"><label for="teacherType">教师身份</label><select id="teacherType">${opts(["未知","在校生","专职老师"],editing?.teacherType||"未知")}</select></div>
          <div class="field"><label for="teacherCanTeach">明确可教科目 *</label><input id="teacherCanTeach" maxlength="200" value="${h(editing?.canTeach||"")}" placeholder="数学、物理、化学"/></div>
          <div class="field"><label for="teacherDistricts">明确希望接单的区（可选）</label><input id="teacherDistricts" maxlength="200" value="${h(editing?.preferredDistricts||"")}" placeholder="津南区、河西区，不填也可入库"/></div>
          <div class="field"><label for="teacherAvailability">现在能否接新单</label><select id="teacherAvailability">${opts(TEACHER_AVAILABILITIES,editing?.availability||"待确认")}</select></div>
          <div class="field"><label for="teacherAgentName">代理名称（可选）</label><input id="teacherAgentName" maxlength="100" value="${h(editing?.agentName||"")}" placeholder="代理人 / 渠道名"/></div>
          <div class="field"><label for="teacherContact">微信号或联系方式（可选，仅手填）</label><input id="teacherContact" maxlength="150" value="${h(editing?.contact||"")}" placeholder="AI 不会填写此项"/></div>
          <div class="field"><label for="teacherNote">管理员备注（可选）</label><input id="teacherNote" maxlength="800" value="${h(editing?.note||"")}" placeholder="老师时间限制、跟进记录等"/></div>
          <div class="full assignment-actions"><button class="btn btn-primary" type="submit" ${cloudReady?"":"disabled"}>${editing?"保存老师档案":"加入储备池"}</button>
          <button class="btn btn-sm" id="teacherResetEditor" type="button">清空 / 新增</button></div>
        </form>
      </div>
      <div class="teacher-pool-right">
        <h3>老师档案（${profiles.length}）</h3>
        <input id="teacherSearch" type="search" placeholder="搜索老师姓名、科目、学校、代理" value="${h(teacherQuery)}"/>
        <div class="teacher-pool-list">
          ${list.length?list.map(p=>`<div class="teacher-pool-item">
            <div><strong>${h(p.name)}</strong><span class="chip">${h(p.gender||"未知")}</span><span class="chip">${h(p.availability||"待确认")}</span>
            <small>${h(p.school||p.teacherType||"学校待补充")} · 可带 ${h(p.canTeach||"待补充")}${p.agentName?" · 代理："+h(p.agentName):""}</small>
            <small>${h(p.preferredDistricts?"明确意向："+p.preferredDistricts:"区域未明确")} · 历史投递 ${applications.filter(a=>a.teacherId===p.id).length} 单</small></div>
            <div class="teacher-pool-item-actions">
              <select data-quick-teacher-status="${h(p.id)}" aria-label="${h(p.name)}的接单状态">${opts(TEACHER_AVAILABILITIES,p.availability||"待确认")}</select>
              <button class="btn btn-sm" type="button" data-edit-teacher="${h(p.id)}">编辑</button>
              <button class="btn btn-sm" type="button" data-remove-teacher="${h(p.id)}">删除</button>
            </div>
          </div>`).join(""):'<p class="admin-helper">暂无老师档案。直接录入一份简历即可先建立储备池。</p>'}
        </div>
      </div>
    </div>
    <div class="teacher-application-panel" id="teacherApplicationPanel">
      <h3>${active?"投递老师 · "+showOrderName(active):"关联投递老师：请从下方家教单点击「登记投递」"}</h3>
      ${active?`
        <p class="admin-helper">已有 ${linked.length} 位投递，登记不代表成功接单，不会自动下架家教单。</p>
        <form id="teacherApplicationForm" class="teacher-link-form">
          <label class="field">选择储备老师
            <select id="applicationTeacherId" required><option value="">请选择老师</option>${profiles.map(p=>`<option value="${h(p.id)}">${h(p.name)} · ${h(p.canTeach||"科目待补充")} · ${h(p.availability||"待确认")}</option>`).join("")}</select></label>
          <label class="field">代理名称（可选）<input id="applicationAgentName" maxlength="100" placeholder="此单由哪个代理推荐"/></label>
          <label class="field">投递进展<select id="applicationStatus">${opts(["已投递","待联系","沟通中","试课中","已接单","未录用"],"已投递")}</select></label>
          <label class="field">备注<input id="applicationNote" maxlength="500" placeholder="家长待反馈 / 老师有意向"/></label>
          <div class="teacher-link-actions"><button class="btn btn-primary" type="submit" ${cloudReady?"":"disabled"}>关联到本单</button><button class="btn btn-sm" type="button" id="addTeacherFromOrder">还没有档案？先录入老师</button></div>
        </form>
        <div class="teacher-linked-list">
          ${linked.length?linked.map(c=>{
            const p=profiles.find(t=>t.id===c.teacherId);
            return `<div class="teacher-linked-item"><span><strong>${h(p?.name||"档案已删除")}</strong> · ${h(c.status||"已投递")} ${h(p?.school||"")} ${c.agentName?" · 代理："+h(c.agentName):""}<small>${h(c.note||"")}</small></span><div class="teacher-link-actions"><button class="btn btn-sm" data-edit-application="${h(c.id)}" type="button">编辑进展</button><button class="btn btn-sm" data-remove-application="${h(c.id)}" type="button">取消关联</button></div></div>`;
          }).join(""):'<p class="admin-helper">本单尚未登记投递老师</p>'}
        </div>
        <div class="teacher-recommend-panel"><h4>优先联系的老师（可接单）</h4>
          ${matched.length?matched.map(t=>`<div class="teacher-match-row">
            <div><strong>${h(t.name)}</strong> <small>${h(t.school)} · ${h(t.gender)} · ${h(t.reasons.join("、"))}</small></div>
            <button class="btn btn-sm" type="button" data-use-recommendation="${h(t.teacherId)}">登记投递</button>
          </div>`).join(""):'<p class="admin-helper">暂无符合条件且明确可接单的老师。已接满、暂不接单和待确认的老师不会出现在推荐中。</p>'}
        </div>
      `:""}
    </div>
    ${overdue.length?`<div class="teacher-overdue-panel"><h3>超 10 天未匹配的家教单</h3>
      ${overdue.slice(0,8).map(({order,age})=>`<div class="teacher-overdue-item"><span><strong>${showOrderName(order)}</strong> <small>已招募${age.days}天 · 可联系 ${recommendTeacherProfiles(order,profiles,applications,orders,legacyAssignments,3).map(p=>h(p.name)).join("、")||"暂无合适老师"}</small></span><button class="btn btn-sm" data-open-app="${h(order.id)}">跟进</button></div>`).join("")}
    </div>`:""}
  </section>`;
}

async function fileToResumeData(file) {
  if(!file)return {};
  if(/\.(txt|md)$/i.test(file.name)||file.type.startsWith("text/")) {
    if(file.size>300000)throw new Error("文本简历超过 300KB，请复制主要内容");
    return {text:(await file.text()).slice(0,16000)};
  }
  if(!["image/jpeg","image/png","image/webp"].includes(file.type))
    throw new Error("暂支持 JPG、PNG、WebP 简历图片；PDF/Word 请复制文字或截图");
  if(file.size>10000000)throw new Error("图片超过 10MB，请压缩后上传");
  const bitmap=await createImageBitmap(file);
  let scale=Math.min(1,1350/Math.max(bitmap.width,bitmap.height));
  let data="";
  for(let i=0;i<4;i++) {
    const canvas=document.createElement("canvas");
    canvas.width=Math.max(1,Math.round(bitmap.width*scale));
    canvas.height=Math.max(1,Math.round(bitmap.height*scale));
    const ctx=canvas.getContext("2d");
    if(!ctx)throw new Error("浏览器不支持图片处理");
    ctx.fillStyle="#fff";ctx.fillRect(0,0,canvas.width,canvas.height);
    ctx.drawImage(bitmap,0,0,canvas.width,canvas.height);
    data=canvas.toDataURL("image/jpeg",0.72-i*0.12);
    if(data.length<1150000)break;
    scale*=0.75;
  }
  bitmap.close?.();
  if(data.length>=1200000)throw new Error("图片压缩后仍太大，请截图主要内容再上传");
  return {imageData:data};
}

export function bindTeacherPool(container,store,rerender,showToast) {
  const reveal=(id)=>{
    activeOrderId=id;
    rerender();
    document.getElementById("teacherApplicationPanel")?.scrollIntoView({behavior:"smooth",block:"start"});
  };
  container.querySelectorAll("[data-open-app]").forEach(btn=>btn.onclick=()=>reveal(btn.dataset.openApp));
  container.querySelectorAll("[data-edit-teacher]").forEach(btn=>btn.onclick=()=>{
    editingTeacherId=btn.dataset.editTeacher;
    autoLinkOrderId="";resumeInput="";latestExtraction="";
    rerender();
    document.getElementById("teacherProfileEditor")?.scrollIntoView({behavior:"smooth",block:"start"});
  });
  container.querySelectorAll("[data-remove-teacher]").forEach(btn=>btn.onclick=async()=>{
    const id=btn.dataset.removeTeacher;
    const used=store.getTeacherApplications().filter(c=>c.teacherId===id).length;
    if(!confirm("删除这份老师档案及关联的 "+used+" 条投递记录？历史家教单不会被修改。"))return;
    try{await store.deleteTeacherProfile(id);editingTeacherId="";rerender();showToast("已删除老师档案及投递关联");}
    catch(error){showToast("删除失败："+error.message);}
  });
  container.querySelectorAll("[data-quick-teacher-status]").forEach(select=>select.onchange=async()=>{
    const status=select.value;
    select.disabled=true;
    try{await store.setTeacherAvailability(select.dataset.quickTeacherStatus,status);rerender();showToast("老师接单状态已更新");}
    catch(error){select.disabled=false;showToast("保存失败："+error.message);}
  });
  const teacherSearch=document.getElementById("teacherSearch");
  if(teacherSearch)teacherSearch.oninput=()=>{teacherQuery=teacherSearch.value;rerender();document.getElementById("teacherSearch")?.focus();};
  const teacherResume=document.getElementById("teacherResumeText");
  if(teacherResume) teacherResume.oninput=()=>{resumeInput=teacherResume.value;};
  const clear=document.getElementById("teacherResetEditor");
  if(clear)clear.onclick=()=>{editingTeacherId="";autoLinkOrderId="";resumeInput="";latestExtraction="";rerender();};
  const extract=document.getElementById("teacherAIExtract");
  if(extract)extract.onclick=async()=>{
    const file=document.getElementById("teacherResumeFile")?.files?.[0];
    const text=document.getElementById("teacherResumeText")?.value.trim()||"";
    if(!file&&!text)return showToast("请先粘贴简历或选择图片文件");
    extract.disabled=true;extract.textContent="AI 正在识别…";
    try{
      const input=await fileToResumeData(file);
      const ai=await callServerlessAI("extract_teacher_resume",{text:[text,input.text||""].filter(Boolean).join("\n"),imageData:input.imageData||""});
      if(ai.teacherName)document.getElementById("teacherName").value=ai.teacherName;
      if(ai.teacherSchool)document.getElementById("teacherSchool").value=ai.teacherSchool;
      if(["男","女"].includes(ai.teacherGender))document.getElementById("teacherGender").value=ai.teacherGender;
      if(["在校生","专职老师"].includes(ai.teacherType))document.getElementById("teacherType").value=ai.teacherType;
      if(ai.canTeach&&!document.getElementById("teacherCanTeach").value.trim())
        document.getElementById("teacherCanTeach").value=ai.canTeach;
      latestExtraction="识别置信度："+(ai.confidence||"待确认")+(ai.warning?"；"+ai.warning:"")+"。请检查姓名、学校与科目；联系方式不自动提取。";
      document.getElementById("teacherExtractResult").textContent=latestExtraction;
      showToast(ai.teacherName?"简历识别成功，请核对后保存":"AI 未确认姓名，请手动填写");
    }catch(error){latestExtraction="简历识别失败："+error.message;document.getElementById("teacherExtractResult").textContent=latestExtraction;showToast(latestExtraction);}
    finally{extract.disabled=false;extract.textContent="✨ AI 提取姓名 / 学校 / 性别 / 科目";}
  };
  const profileForm=document.getElementById("teacherProfileForm");
  if(profileForm)profileForm.onsubmit=async(event)=>{
    event.preventDefault();
    const button=profileForm.querySelector('button[type="submit"]');button.disabled=true;
    try{
      const profileId=await store.saveTeacherProfile({
        id:editingTeacherId||undefined,
        name:document.getElementById("teacherName").value.trim(),
        school:document.getElementById("teacherSchool").value.trim(),
        gender:document.getElementById("teacherGender").value,
        teacherType:document.getElementById("teacherType").value,
        canTeach:document.getElementById("teacherCanTeach").value.trim(),
        preferredDistricts:document.getElementById("teacherDistricts").value.trim(),
        availability:document.getElementById("teacherAvailability").value,
        agentName:document.getElementById("teacherAgentName").value.trim(),
        contact:document.getElementById("teacherContact").value.trim(),
        note:document.getElementById("teacherNote").value.trim()
      });
      if(autoLinkOrderId){
        await store.saveTeacherApplication({teacherId:profileId,orderId:autoLinkOrderId,status:"已投递"});
        autoLinkOrderId="";
        showToast("老师档案已保存并关联到本单，订单状态未改变");
      }else showToast("老师档案已存入储备池");
      editingTeacherId="";latestExtraction="";resumeInput="";rerender();
    }catch(error){button.disabled=false;showToast("保存失败："+error.message);}
  };
  const linkForm=document.getElementById("teacherApplicationForm");
  if(linkForm)linkForm.onsubmit=async(event)=>{
    event.preventDefault();
    const submit=linkForm.querySelector('button[type="submit"]');submit.disabled=true;
    try{
      await store.saveTeacherApplication({
        teacherId:document.getElementById("applicationTeacherId").value,
        orderId:activeOrderId,
        agentName:document.getElementById("applicationAgentName").value.trim(),
        status:document.getElementById("applicationStatus").value,
        note:document.getElementById("applicationNote").value.trim()
      });
      rerender();showToast("投递老师已关联到本单，订单上架状态保持不变");
    }catch(error){submit.disabled=false;showToast("登记失败："+error.message);}
  };
  document.getElementById("addTeacherFromOrder")?.addEventListener("click",()=>{
    editingTeacherId="";resumeInput="";latestExtraction="";autoLinkOrderId=activeOrderId;rerender();
    document.getElementById("teacherProfileEditor")?.scrollIntoView({behavior:"smooth",block:"start"});
  });
  container.querySelectorAll("[data-use-recommendation]").forEach(btn=>btn.onclick=()=>{
    const select=document.getElementById("applicationTeacherId");
    if(select){select.value=btn.dataset.useRecommendation;select.focus();}
  });
  container.querySelectorAll("[data-edit-application]").forEach(btn=>btn.onclick=()=>{
    const item=store.getTeacherApplications().find(x=>x.id===btn.dataset.editApplication);
    if(!item)return;
    document.getElementById("applicationTeacherId").value=item.teacherId;
    document.getElementById("applicationStatus").value=item.status;
    document.getElementById("applicationAgentName").value=item.agentName||"";
    document.getElementById("applicationNote").value=item.note||"";
    document.getElementById("applicationNote").focus();
  });
  document.getElementById("applicationTeacherId")?.addEventListener("change",event=>{
    const teacher=store.getTeacherProfiles().find(x=>x.id===event.target.value);
    const agent=document.getElementById("applicationAgentName");
    if(teacher?.agentName&&agent&&!agent.value.trim())agent.value=teacher.agentName;
  });
  container.querySelectorAll("[data-remove-application]").forEach(btn=>btn.onclick=async()=>{
    if(!confirm("取消这位老师和当前订单的投递关联吗？不会修改订单状态或老师档案。"))return;
    try{await store.deleteTeacherApplication(btn.dataset.removeApplication);rerender();showToast("投递关联已移除");}
    catch(error){showToast(error.message);}
  });
}
export function openTeacherApplication(orderId,rerender) {
  activeOrderId=orderId;
  rerender();
  document.getElementById("teacherApplicationPanel")?.scrollIntoView({behavior:"smooth",block:"start"});
}
export function presentTeacherMatches(orders,store) {
  const profiles=store.getTeacherProfiles(),applications=store.getTeacherApplications();
  if(!orders?.length)return;
  const recommendations=orders.map(order=>({order,candidates:recommendTeacherProfiles(order,profiles,applications,store.getOrders(),store.getAssignments(),5)}));
  const markup=recommendations.map(({order,candidates})=>`<div class="teacher-publish-item">
    <strong>${h(order.orderNumber||order.id)} · ${h(order.grade)}${h(order.subject)}</strong>
    ${candidates.length?`<p>建议联系：${candidates.map(x=>h(x.name)+"（"+h(x.reasons.slice(0,2).join("、"))+"）").join("；")}</p>`:
      '<p>暂无符合条件、且标为可接单的储备老师。</p>'}
  </div>`).join("");
  document.getElementById("teacherPublishedMatchModal")?.remove();
  const modal=document.createElement("div");modal.id="teacherPublishedMatchModal";modal.className="teacher-publish-overlay";
  modal.innerHTML=`<section class="teacher-publish-dialog" role="dialog" aria-modal="true" aria-labelledby="publishMatchTitle">
    <h2 id="publishMatchTitle">🎯 新单已发布 · 储备老师推荐</h2>
    <p class="admin-helper">仅按已明确可教科目、明确接单区域和历史投递筛选；已接满/暂不接单/待确认的老师不会被推荐。请人工联系确认时间。</p>
    <div class="teacher-publish-results">${markup}</div>
    <button class="btn btn-primary" id="closeTeacherPublishedModal" type="button">我知道了</button>
  </section>`;
  document.body.appendChild(modal);
  document.getElementById("closeTeacherPublishedModal")?.addEventListener("click",()=>modal.remove());
  modal.addEventListener("click",e=>{if(e.target===modal)modal.remove();});
  document.getElementById("closeTeacherPublishedModal")?.focus();
}
