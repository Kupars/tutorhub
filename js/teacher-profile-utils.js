import {resolveRoutePoint,resolveDepartureLandmark,requestRoute,runLimited,routeLabel} from "./route-client.js?v=3";
import {stageOf,cleanTeachingPairs,cleanCompanionOptions} from "../shared/teacher-capabilities.js";
// 老师档案推荐：仅利用管理员录入的偏好与历史投递/接单，不获取老师实时位置。
import { verifiedPublicLandmarkCoords, inferNamedLandmarkCoords } from "./commute.js";
import { isPubliclyOpenOrder } from "./board-utils.js";
export const TEACHER_AVAILABILITIES = ["可接单","已接满","待确认"];
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

const gradeTokens=v=>[...new Set(String(v||"").match(/小学|初中|高中|[一二三四五六]年级|初[一二三]|高[一二三]/g)||[])];
const gradeMatches=(level,grade)=>level===grade || (level==="高中"&&/^高[一二三]/.test(grade)) ||
  (level==="初中"&&/^初[一二三]/.test(grade)) || (level==="小学"&&/^[一二三四五六]年级/.test(grade));
function days(v){
  const text=trim(v);if(!text||/不|除|以外|未定|待确认/.test(text))return [];
  const d=new Set();
  if(/每天|每日|天天|全周/.test(text))for(const x of "一二三四五六日")d.add(x);
  if(/周末/.test(text)){d.add("六");d.add("日");}
  if(/周中|工作日/.test(text))for(const x of "一二三四五")d.add(x);
  for(const m of text.matchAll(/(?:周|星期)([一二三四五六日天])/g))d.add(m[1]==="天"?"日":m[1]);
  return [...d];
}
function dayparts(v){
  const text=trim(v);
  if(!text||/不|除|以外|未定|待确认|全天|不限/.test(text))return [];
  const found=new Set();
  if(/上午|早上|早晨/.test(text))found.add("上午");
  if(/下午/.test(text))found.add("下午");
  if(/晚上|晚间|傍晚/.test(text))found.add("晚上");
  return [...found];
}
function timeCompatible(available,requested){
 const d=days(available),r=days(requested),p=dayparts(available),q=dayparts(requested);
 return (!d.length||!r.length||r.some(x=>d.includes(x)))&&(!p.length||!q.length||q.some(x=>p.includes(x)));
}
function point(address,district=""){
  if(!address)return null;
  return verifiedPublicLandmarkCoords(address)||inferNamedLandmarkCoords(address,district);
}
function km(a,b){
  if(!a||!b)return null;
  const rad=x=>x*Math.PI/180;
  const h=Math.sin(rad(b.lat-a.lat)/2)**2+Math.cos(rad(a.lat))*Math.cos(rad(b.lat))*Math.sin(rad(b.lng-a.lng)/2)**2;
  return 12742*Math.asin(Math.sqrt(Math.min(1,h)));
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
    const levels=gradeTokens(teacher.gradeLevels),targetGrade=trim(target.grade),stage=stageOf(targetGrade);
    const pairs=cleanTeachingPairs(teacher.teachingPairs),companions=cleanCompanionOptions(teacher.companionOptions);
    const isCompanion=/陪读|作业陪伴/.test([target.subject,target.title,target.requirements].join(" "));
    const relevantCompanions=companions.filter(x=>!stage||x.stage===stage);
    if(isCompanion && !relevantCompanions.length && (companions.length||pairs.length||!subjectTokens(teacher.canTeach).includes("陪读")))continue;
    if(!isCompanion && pairs.length && stage && !pairs.some(x=>x.stage===stage))continue;
    if(!pairs.length&&!isCompanion&&levels.length&&targetGrade&&!levels.some(x=>gradeMatches(x,targetGrade)))continue;
    const targetDays=days(target.weeklyFrequency);
    const teacherDays=days(teacher.availableTimes||teacher.preferences);
    if(!timeCompatible(teacher.availableTimes||teacher.preferences,target.weeklyFrequency))continue;
    if(isCompanion&&relevantCompanions.length&&!relevantCompanions.some(x=>timeCompatible(x.time,target.weeklyFrequency)))continue;
    const taught=isCompanion?["陪读"]:pairs.length?pairs.filter(x=>!stage||x.stage===stage).map(x=>x.subject):subjectTokens(teacher.canTeach);
    const districts=districtTokens(teacher.preferredDistricts);
    const interest=trim(teacher.interestLocations).split(/[、，,；;\n]/).map(x=>x.trim()).filter(x=>x&&!/\d{5,}|门牌|室|单元|楼栋|号楼/.test(x));
    const history=candidacies.filter(x=>x.teacherId===teacher.id);
    const previousOrders=history.map(c=>byOrder.get(trim(c.orderId))).filter(Boolean);
    const recentRefs=new Set(String(teacher.recentOrderRefs||"").match(/#\d{3,7}(?:-\d+)?/g)||[]);
    const recentOrders=orders.filter(o=>recentRefs.has(trim(o.orderNumber||o.id)));
    // A repeated historical display label is ambiguous; don't pick an arbitrary address.
    for(const o of recentOrders)if(recentOrders.filter(x=>trim(x.orderNumber||x.id)===trim(o.orderNumber||o.id)).length===1)previousOrders.push(o);
    const legacy=legacyAssignments.filter(a=>trim(a.teacherName)===trim(teacher.name) && trim(a.teacherContact)===trim(teacher.contact));
    const evidence=previousOrders.concat(legacy,interest.map(publicAddress=>({publicAddress,district:publicAddress.match(/和平区|河西区|南开区|河东区|河北区|红桥区|津南区|西青区|东丽区|北辰区|武清区|滨海新区|宝坻区|静海区|宁河区|蓟州区/)?.[0]||""})));
    let score=0;
    const reasons=[],checks=[];
    if((pairs.length||relevantCompanions.length&&isCompanion)&&stage){score+=3;reasons.push("明确记录对应学段");}else if(levels.length&&targetGrade){checks.push("核对科目与学段对应关系");}else checks.push("核对可教年级");
    if(teacherDays.length&&targetDays.length){score+=3;reasons.push("上课日期有交集");}else checks.push("核对上课日期");
    checks.push("确认具体时段、课时与通勤");
    const requested=isCompanion?["陪读"]:targetSubjects;
    const overlaps=requested.filter(s=>taught.includes(s)||taught.includes("全科"));
    const needsAll=(Number(target.teacherCount)||1)<=1;
    if (!taught.length || (requested.length &&
        (needsAll ? overlaps.length!==requested.length : overlaps.length===0))) {
      // 一位老师负责多科时必须全部覆盖；多位教师分工时可以推荐部分科目。
      continue;
    }
    if (overlaps.length) {
      score+=needsAll?10:7;
      reasons.push(needsAll?"明确可教全部要求科目":"可教部分科目："+overlaps.join("、"));
    }
    if(targetDistrict && (districts.includes(targetDistrict)||trim(teacher.preferences).includes(targetDistrict))) {
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
    const targetPoint=point(target.publicAddress||target.address,targetDistrict);
    const departure=point(teacher.departureLandmark);
    let distanceKm=km(departure,targetPoint),distanceBasis=distanceKm===null?"":"老师明确出发地与订单地标的直线距离";
    if(distanceKm===null){
      const distances=evidence.map(o=>km(point(o.publicAddress||o.address,o.district),targetPoint)).filter(d=>d!==null);
      if(distances.length){distanceKm=Math.min(...distances);distanceBasis="历史订单地址与本单地址的直线距离（非老师通勤）";}
    }
    if(distanceKm!==null){score+=Math.max(0,8-distanceKm/2);reasons.unshift(distanceBasis+"约"+distanceKm.toFixed(1)+"公里（非路线耗时）");}
    if(teacher.departureLandmark)checks.push("未取得高德路线时，不提供通勤耗时");
    if(!score)continue;
    if(teacher.starred===true){score+=6;reasons.unshift("星标老师（历史合作优先）");}
    result.push({
      starred:teacher.starred===true,
      teacherId:teacher.id,name:trim(teacher.name),school:trim(teacher.currentSchool||teacher.school||teacher.graduatedSchool),
      gender:trim(teacher.gender),availability:teacher.availability,
      contact:trim(teacher.contact),agentName:trim(teacher.agentName),
      reasons,checks,distanceKm,distanceBasis,score,historyCount:history.length,
      warning:"历史投递地点只是兴趣线索，不代表老师住址、实时位置或当前档期"
    });
  }
  return result.sort((a,b)=>b.score-a.score||b.historyCount-a.historyCount||a.name.localeCompare(b.name))
    .slice(0,Math.max(1,Math.min(20,limit)));
}

// 即时匹配不写入老师档案；当前简历由管理员发起，不将未知空闲状态保存到储备库。
export function recommendOrdersForTeacher(teacher,orders=[],candidacies=[],legacy=[],limit=8){
  if(!trim(teacher?.canTeach)&&!cleanTeachingPairs(teacher?.teachingPairs).length&&!cleanCompanionOptions(teacher?.companionOptions).length)return [];
  if(["已接满","暂不接单","排满"].includes(teacher.availability))return [];
  const profile={...teacher,id:teacher.id||"temporary-teacher",availability:"可接单"};
  return orders.filter(isPubliclyOpenOrder).map(order=>{
    const match=recommendTeacherProfiles(order,[profile],candidacies,orders,legacy,1)[0];
    return match?{order,...match}:null;
  }).filter(Boolean).sort((a,b)=>b.score-a.score).slice(0,limit);
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

// Only explicit teacher departure landmarks can produce actual commuting routes.
// Historical addresses remain an interest signal and never become a teacher's origin.
export function applyPlannedRoute(match,route){
 if(!route||!Number.isFinite(route.bestMin))return match;
 const oldBonus=match.distanceKm!==null?Math.max(0,8-match.distanceKm/2):0;
 const routeBonus=Math.max(0,8-route.bestMin/10);
 return {...match,route,score:match.score-oldBonus+routeBonus,checks:match.checks?.filter(x=>x!=="未取得高德路线时，不提供通勤耗时"),reasons:[routeLabel(route),...match.reasons.filter(x=>!x.includes("直线距离")&&!x.includes("历史订单地址与本单地址"))]};
}
export async function recommendTeacherProfilesWithRoutes(target,profiles=[],candidacies=[],orders=[],legacy=[],limit=5,budget={remaining:8}){
 const shortlist=recommendTeacherProfiles(target,profiles,candidacies,orders,legacy,Math.min(12,Math.max(limit,8)));
 if(!budget.remaining||!shortlist.some(m=>profiles.find(p=>p.id===m.teacherId)?.departureLandmark))return shortlist.slice(0,limit);
 const dest=await resolveRoutePoint(target);
 if(!dest)return shortlist.slice(0,limit);
 const results=await runLimited(shortlist,async m=>{
  const teacher=profiles.find(p=>p.id===m.teacherId);
  if(!teacher?.departureLandmark||budget.remaining<=0)return m;
  budget.remaining--;
  const origin=await resolveDepartureLandmark(teacher.departureLandmark);
  return origin?applyPlannedRoute(m,await requestRoute(origin,dest)):m;
 });
 return results.filter(Boolean).sort((a,b)=>b.score-a.score).slice(0,limit);
}
export async function recommendOrdersForTeacherWithRoutes(teacher,orders=[],candidacies=[],legacy=[],limit=8){
 const shortlist=recommendOrdersForTeacher(teacher,orders,candidacies,legacy,Math.min(12,Math.max(limit,10)));
 if(!teacher.departureLandmark)return shortlist.slice(0,limit);
 const origin=await resolveDepartureLandmark(teacher.departureLandmark);
 if(!origin)return shortlist.slice(0,limit);
 const results=await runLimited(shortlist,async m=>{
  const dest=await resolveRoutePoint(m.order);
  return dest?applyPlannedRoute(m,await requestRoute(origin,dest)):m;
 });
 return results.filter(Boolean).sort((a,b)=>b.score-a.score).slice(0,limit);
}
