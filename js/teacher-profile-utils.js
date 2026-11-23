// 老师档案推荐：仅利用管理员录入的偏好与历史投递/接单，不获取老师实时位置。
export const TEACHER_AVAILABILITIES = ["可接单","已接满","暂不接单","待确认"];
export const TEACHER_GENDERS = ["男","女","未知"];
const trim=v=>String(v??"").trim();
const location=v=>trim(v).replace(/天津市|天津|[\s，,。·()（）]/g,"").toLowerCase();
export const subjectTokens=v=>{
  const raw=trim(v);
  const recognized=[...raw.matchAll(/数学|物理|化学|英语|语文|生物|地理|历史|政治|科学|编程|信息技术|计算机|全科|陪读|作业辅导|体育|音乐|美术|德语|法语|日语/g)].map(m=>m[0]);
  if(/数理化/.test(raw))recognized.push("数学","物理","化学");
  return [...new Set(recognized.length?recognized:raw.split(/[、，,＋+\/和\s]+/).map(s=>s.trim()).filter(Boolean))];
};
export const districtTokens=v=>[...new Set(trim(v).split(/[、，,;；\/\s]+/).map(s=>s.trim()).filter(Boolean))];

export function wantedTeacherGender(order) {
  const req=[order?.requirements,order?.genderPref].map(trim).join(" ");
  const male=/男(?:性)?老师|男教师|男大学生|男生老师/.test(req);
  const female=/女(?:性)?老师|女教师|女大学生|女生老师/.test(req);
  if(male===female)return {gender:"未知",strict:false};
  const gender=male?"男":"女";
  const strict=new RegExp("(?:只要|仅限|必须|指定|限)"+gender+"(?:老师|教师|生)|"+gender+"(?:老师|教师)(?:限定|必须)").test(req);
  return {gender,strict};
}

export function recommendTeacherProfiles(target,profiles=[],candidacies=[],orders=[],legacyAssignments=[],limit=5) {
  const byOrder=new Map(orders.map(o=>[trim(o.id),o]));
  const preference=wantedTeacherGender(target);
  const result=[];
  const targetSubjects=subjectTokens(target.subject);
  const targetAddress=location(target.publicAddress||target.address);
  const targetDistrict=trim(target.district);
  for(const teacher of profiles) {
    if(teacher.availability!=="可接单")continue;
    if(preference.strict && teacher.gender!==preference.gender)continue;
    const taught=subjectTokens(teacher.canTeach);
    const districts=districtTokens(teacher.preferredDistricts);
    const history=candidacies.filter(x=>x.teacherId===teacher.id);
    const previousOrders=history.map(c=>byOrder.get(trim(c.orderId))).filter(Boolean);
    const legacy=legacyAssignments.filter(a=>trim(a.teacherName)===trim(teacher.name) && trim(a.teacherContact)===trim(teacher.contact));
    const evidence=previousOrders.concat(legacy);
    let score=0;
    const reasons=[];
    const overlaps=targetSubjects.filter(s=>taught.includes(s)||taught.includes("全科"));
    const needsAll=(Number(target.teacherCount)||1)<=1;
    if (!taught.length || (targetSubjects.length &&
        (needsAll ? overlaps.length!==targetSubjects.length : overlaps.length===0))) {
      // 一位老师负责多科时必须全部覆盖；多位教师分工时可以推荐部分科目。
      continue;
    }
    if (overlaps.length) {
      score+=needsAll?10:7;
      reasons.push(needsAll?"明确可教全部要求科目":"可教部分科目："+overlaps.join("、"));
    }
    if(districts.includes(targetDistrict) && targetDistrict) {
      score+=6;reasons.push("明确愿意在该区授课");
    }
    const samePlace=evidence.some(o=>location(o.publicAddress||o.address)===targetAddress && targetAddress.length>=5);
    if(samePlace) {score+=5;reasons.push("过去曾投递/接过同一公开地点的单");}
    else if(evidence.some(o=>trim(o.district)===targetDistrict && targetDistrict)) {
      score+=2;reasons.push("过去曾关注该区的单");
    }
    const sameSubject=evidence.some(o=>subjectTokens(o.subject).some(s=>targetSubjects.includes(s)));
    if(sameSubject) {score+=2;reasons.push("有相关科目投递/接单记录");}
    if(preference.gender!=="未知" && teacher.gender===preference.gender) {
      score+=4;reasons.push("符合老师性别倾向");
    } else if(preference.gender!=="未知" && teacher.gender==="未知") {
      reasons.push("老师性别待确认");
    }
    if(!score)continue;
    result.push({
      teacherId:teacher.id,name:trim(teacher.name),school:trim(teacher.school),
      gender:trim(teacher.gender),availability:teacher.availability,
      contact:trim(teacher.contact),agentName:trim(teacher.agentName),
      reasons,score,historyCount:history.length,
      warning:"历史投递地点只是兴趣线索，不代表老师住址、实时位置或当前档期"
    });
  }
  return result.sort((a,b)=>b.score-a.score||b.historyCount-a.historyCount||a.name.localeCompare(b.name))
    .slice(0,Math.max(1,Math.min(20,limit)));
}

export function linkedOrderFamilyKey(order) {
  const id=trim(order?.orderNumber||order?.id);
  return /^#\d{3,7}(?:-\d+)?$/.test(id)?id.replace(/-\d+$/,""):"";
}

export function nextFamilySubIds(root,count,orders=[]) {
  const code=trim(root);
  if(!/^#\d{3,7}$/.test(code)||!Number.isInteger(count)||count<1||count>30)
    throw new Error("主编号应为 #数字，且子单数量为 1～30");
  const occupied=new Set(orders.map(o=>trim(o.orderNumber||o.id)));
  const output=[];
  for(let i=1;output.length<count&&i<1000;i++) {
    const id=code+"-"+i;
    if(!occupied.has(id)) {output.push(id);occupied.add(id);}
  }
  if(output.length!==count)throw new Error("主编号下已无可用子单编号");
  return output;
}
