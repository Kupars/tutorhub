// 管理员自己决定科目的拆分与合并。只改变未发布草稿，不修改已发布订单。
// 正式单号由每次发布前的序号检查保护，不把不同家庭自动合并。
import { getSubjectList, normalizeOrder, nextOrderId } from "./order-format.js";

const text = (x) => String(x || "").trim();
const rootId = (id) => text(id).replace(/-\d+$/,"");
function newSuffix(root, occupied){
  for(let n=1;n<1000;n++)if(!occupied.has(root+"-"+n)){const id=root+"-"+n;occupied.add(id);return id;}
  throw new Error("子编号已用完");
}
function scoreForSubjects(original, subs) {
  const current=text(original.currentScores);
  if(!current||current==="成绩待补充")return "成绩待补充";
  const chunks=current.split(/[，,；;\n]/).map(s=>s.trim()).filter(Boolean);
  const picked=chunks.filter(part=>subs.some(s=>part.includes(s)));
  // 无逐科成绩时保留原“总成绩”描述，不臆断其属于哪个学科。
  return picked.length ? picked.join("，") : (subs.length===getSubjectList(original.subject).length?current:"成绩待补充");
}
function rewrite(draft, subjects, id) {
  const subject=subjects.join("、");
  return normalizeOrder({
    ...draft,id,orderNumber:id,subject,title:String(draft.grade)+subject+"家教",
    currentScores:scoreForSubjects(draft,subjects),
    groupingDecision:"手动调整",groupingReason:"管理员按科目选择"
  });
}
export function splitDraftSubjects(drafts, selected) {
  const input=Array.isArray(drafts)?drafts:[];
  const keys=new Set(selected||[]);
  const occupied=new Set(input.map(o=>text(o.id)));
  const result=[];
  for(let i=0;i<input.length;i++){
    const draft=input[i],subs=getSubjectList(draft.subject);
    const hit=subs.filter(s=>keys.has(i+"::"+s));
    if(!hit.length || subs.length===1){result.push(draft);continue;}
    const left=subs.filter(s=>!hit.includes(s));
    const groups=left.length?[...hit.map(s=>[s]),left]:hit.map(s=>[s]);
    if(groups.length<2){result.push(draft);continue;}
    const root=rootId(draft.id);
    const ids=groups.map(()=>newSuffix(root,occupied));
    result.push(...groups.map((parts,j)=>rewrite(draft,parts,ids[j])));
  }
  return result;
}

export function mergeDraftSubjects(drafts, selected, confirmSameStudent=false) {
  const input=Array.isArray(drafts)?drafts:[];
  const keys=new Set(selected||[]);
  const selectedChunks=[];
  const remnants=[];
  const occupied=new Set(input.map(o=>text(o.id)));
  for(let i=0;i<input.length;i++){
    const o=input[i],subjects=getSubjectList(o.subject);
    const chosen=subjects.filter(s=>keys.has(i+"::"+s));
    const left=subjects.filter(s=>!chosen.includes(s));
    if(chosen.length) selectedChunks.push({o,chosen});
    if(!chosen.length) remnants.push(o);
    else if(left.length)remnants.push(rewrite(o,left,newSuffix(rootId(o.id),occupied)));
  }
  if(selectedChunks.length<2) throw new Error("至少从两条草稿中各选一个科目，才能合并");
  const base=selectedChunks[0].o;
  const grade=text(base.grade),gender=text(base.studentGender);
  const address=text(base.publicAddress||base.address).replace(/天津市|\s/g,"");
  if(selectedChunks.some(({o})=>text(o.grade)!==grade ||
     text(o.studentGender)!==gender ||
     text(o.publicAddress||o.address).replace(/天津市|\s/g,"")!==address))
    throw new Error("所选草稿年级、学生性别或地址不同，请勿把不同学生合成一单");
  if(!confirmSameStudent && new Set(selectedChunks.map(({o})=>rootId(o.id))).size>1)
    throw new Error("需要管理员明确确认这些科目属于同一学生");
  const subjects=[...new Set(selectedChunks.flatMap(({chosen})=>chosen))];
  const merged=selectedChunks.map(({o,chosen})=>scoreForSubjects(o,chosen))
    .filter(s=>s!=="成绩待补充");
  const requirements=[...new Set(selectedChunks.map(({o})=>text(o.requirements)).filter(s=>s&&s!=="无特殊要求"))];
  let newId=rootId(base.id);
  if(remnants.some(o=>o.id===newId)) newId=newSuffix(newId,occupied);
  const combined=rewrite({...base,currentScores:merged.join("，")||"成绩待补充",
    requirements:requirements.join("；")||"无特殊要求",teacherCount:1},subjects,newId);
  combined.currentScores=merged.join("，")||"成绩待补充";
  return [combined,...remnants];
}

export function checkDraftIds(drafts,existingOrders) {
  const known=new Set((existingOrders||[]).map(o=>String(o.orderNumber||o.id)));
  const all=new Set();const issues=[];
  for(const o of drafts||[]){
    const id=text(o.orderNumber||o.id);
    if(!/^#\d{3,7}(?:-\d+)?$/.test(id)) issues.push(id||"缺少编号");
    if(all.has(id))issues.push(id+"（草稿重复）");
    if(known.has(id))issues.push(id+"（已存在）");
    all.add(id);
  }
  return issues;
}


// 这里只做字段缺失校验，不参与从自然语言提取；所有 AI 提取必须调用远程 API。
export function missingDraftFields(order) {
  const missing=[];
  if(!order?.grade||/待补充/.test(order.grade))missing.push("年级");
  if(!order?.subject||/待补充/.test(order.subject))missing.push("科目");
  if(!order?.studentGender||order.studentGender==="待补充")missing.push("学生性别");
  if(!order?.address||/待补充/.test(order.address))missing.push("补课地址");
  if(!order?.weeklyFrequency||order.weeklyFrequency==="待协商")missing.push("上课频率");
  if(!order?.currentScores||/待补充/.test(order.currentScores))missing.push("成绩");
  return missing;
}

/**
 * 将管理员确认同属一组来源需求的数张独立草稿编为 #主号-1、#主号-2。
 * 不合并不同学生、不依赖同一个代理曾经发来的不同需求；历史已发布单号不会被重新编号。
 */
export function groupDraftsUnderParent(drafts,indices,existingOrders=[]) {
  const list=Array.isArray(drafts)?drafts:[];
  const selected=[...new Set(indices||[])].map(Number).filter(i=>Number.isInteger(i)&&i>=0&&i<list.length).sort((a,b)=>a-b);
  if(selected.length<2)throw new Error("请先勾选至少两条属于同一来源需求的草稿");
  const first=list[selected[0]];
  const id=text(first.orderNumber||first.id);
  const root=/^#\d{3,7}(?:-\d+)?$/.test(id)?rootId(id):
    nextOrderId([...existingOrders,...list]);
  const used=new Set([...existingOrders,...list.filter((_,i)=>!selected.includes(i))]
    .map(o=>text(o.orderNumber||o.id)));
  const replacements=new Map();
  for(let n=0;n<selected.length;n++){
    const next=newSuffix(root,used);
    const original=list[selected[n]];
    replacements.set(selected[n],{...original,id:next,orderNumber:next,
      groupingDecision:"管理员编组",groupingReason:"同一来源需求的独立子单，分别保留原科目、学生及授课条件"});
  }
  return list.map((o,i)=>replacements.get(i)||o);
}
