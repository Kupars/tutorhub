// Explicit subject-stage pairs are authoritative. Legacy independent fields are not expanded into a Cartesian product.
export const TEACHER_TYPES=["未知","在校生","专职老师","机构老师","独立老师","在职老师"];
export const STAGES=["小学","初中","高中"];
export const SUBJECT_OPTIONS=["语文","数学","英语","物理","化学","生物","政治","历史","地理","科学","编程","信息技术","书法","音乐","美术","体育","全科"];
const str=v=>typeof v==="string"?v.trim():"";
export const safeProfileText=(v,max=200)=>str(v).replace(/(?:1[3-9]\d{9}|\b[\w.+-]+@[\w.-]+\.\w+\b)/g,"[已隐藏]").slice(0,max);
export function stageOf(v){
 const s=str(v);
 if(STAGES.includes(s))return s;
 if(/^高[一二三123]$/.test(s))return "高中";
 if(/^初[一二三123]$/.test(s))return "初中";
 if(/^[一二三四五六123456]年级$/.test(s))return "小学";
 return "";
}
export function cleanTeachingPairs(value){
 if(!Array.isArray(value))return [];
 const seen=new Set(),out=[];
 for(const row of value.slice(0,100)){
   if(!row||typeof row!=="object")continue;
   const subject=safeProfileText(row.subject,30),stage=stageOf(row.stage);
   if(!subject||!stage||/陪读|作业陪伴/.test(subject))continue;
   const key=stage+"|"+subject;if(seen.has(key))continue;seen.add(key);out.push({stage,subject});
 }
 return out;
}
export function cleanCompanionOptions(value){
 if(!Array.isArray(value))return [];
 const out=[],seen=new Set();
 for(const row of value.slice(0,20)){
   if(!row||typeof row!=="object")continue;
   const stage=stageOf(row.stage),time=safeProfileText(row.time,100);
   if(!stage)continue;
   const key=stage+"|"+time;if(seen.has(key))continue;seen.add(key);out.push({stage,time});
 }
 return out;
}
export function schoolTag(p){
 if(p?.teacherType!=="在校生")return "";
 const s=str(p.currentSchool||p.school);
 return /^(天津大学|天大)(?:[·（(\s]|$)/.test(s)?"天大":/^(南开大学|南开)(?:[·（(\s]|$)/.test(s)?"南开":"";
}
export function profileCapabilities(p){
 const pairs=cleanTeachingPairs(p?.teachingPairs),companions=cleanCompanionOptions(p?.companionOptions);
 return [...STAGES.map(stage=>{const subjects=pairs.filter(x=>x.stage===stage).map(x=>x.subject);return subjects.length?stage+"："+subjects.join("、"):"";}).filter(Boolean),
  ...companions.map(x=>x.stage+"陪读"+(x.time?"（"+x.time+"）":""))].join("；");
}
export function filterTeacherProfile(p,filter={}){
 const pairs=cleanTeachingPairs(p.teachingPairs),companions=cleanCompanionOptions(p.companionOptions);
 if(filter.starred && p.starred!==true)return false;
 if(filter.type && p.teacherType!==filter.type)return false;
 if(filter.local && p.tianjinGaokao!==filter.local)return false;
 if(filter.school && schoolTag(p)!==filter.school)return false;
 if(filter.gender && p.gender!==filter.gender)return false;
 if(filter.availability && p.availability!==filter.availability)return false;
 if(filter.subject==="陪读")return companions.some(x=>!filter.stage||x.stage===filter.stage);
 if(filter.subject||filter.stage)return pairs.some(x=>(!filter.subject||x.subject===filter.subject)&&(!filter.stage||x.stage===filter.stage))||
  (!filter.subject&&companions.some(x=>x.stage===filter.stage));
 return true;
}
export const LOCAL_GAOKAO=["未知","是","否"];
export const STUDY_LEVELS=["","本科生","硕士生","博士生"];
export const normalizeAge=v=>{const n=Number(v);return Number.isInteger(n)&&n>=14&&n<=100?n:null;};
