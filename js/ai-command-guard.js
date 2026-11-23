// AI 修改白名单：只允许管理员显式确认的安全字段；模型不得执行代码、删除单子或修改隐私数据。
const str = v => String(v ?? "").trim();
const THEMES=new Set(["indigo","emerald","amber","rose"]);
const STATES=new Set(["招募中","已匹配","已结束"]);
const MODES=new Set(["线上","上门","均可"]);
const MAX={grade:28,subject:120,studentGender:8,teacherCount:3,currentScores:300,publicAddress:240,
  weeklyFrequency:200,hoursPerSession:3,requirements:800,salaryText:100,mode:8,
  onlineAllowed:5,trialTime:150,notes:600,urgent:5,status:15,publishedAt:40,title:150};
const SIGNAL={
  grade:/年级|高一|高二|高三|初一|初二|初三|小学/,
  subject:/科目|数学|语文|英语|物理|化学|生物|地理|历史|政治|陪读|全科/,
  studentGender:/学生性别|男学生|女学生|男孩|女孩/,
  teacherCount:/老师人数|几个老师|[1-9]位老师/,
  currentScores:/成绩|分数|考了|基础/,
  publicAddress:/地址|地点|小区|授课地点/,
  weeklyFrequency:/每周|一周|上课时间|周[一二三四五六日天]|频率/,
  hoursPerSession:/小时|每次|单次|时长/,
  requirements:/老师要求|教师要求|资质|经验|必须|优先|有耐心|严格/,
  salaryText:/时薪|薪资|课时费|价格|报价|每小时|元\/小时/,
  mode:/授课方式|线上|线下|上门|网课/,
  onlineAllowed:/网课|线上/,
  trialTime:/试课|试讲/,
  notes:/备注|补充说明/,
  urgent:/急招|急单|加急/,
  status:/招募|匹配|招满|关闭|结束|恢复|上架|下架|状态/,
  publishedAt:/发布日期|发单日期|开始招募|发布时间/,
  title:/标题|单子名称/
};
const compact = v => str(v).replace(/天津市|天津|北京市|北京|[\s，,、。·()（）]/g,"");
function sitePatch(p,text){
  const out={};
  if(typeof p.announcement==="string" && p.announcement.length<=500 && /公告|通知|提示/.test(text))
    out.announcement=p.announcement.trim();
  if(typeof p.heroTitle==="string" && p.heroTitle.length<=120 && /首页|头图|大标题|主标题|顶部文案/.test(text))
    out.heroTitle=p.heroTitle.trim();
  if(typeof p.heroDescription==="string" && p.heroDescription.length<=500 && /首页|说明|介绍|副标题|描述|头图/.test(text))
    out.heroDescription=p.heroDescription.trim();
  if(typeof p.siteName==="string" && p.siteName.length<=80 && /网站名|站点名|网页标题/.test(text))
    out.siteName=p.siteName.trim();
  if(THEMES.has(p.theme) && /主题|颜色|配色|风格|换成.*色|改成.*色/.test(text)) out.theme=p.theme;
  return out;
}
function orderPatch(p,text,old){
  const out={};
  for(const [key,val] of Object.entries(p||{})){
    if(!Object.hasOwn(MAX,key) || !SIGNAL[key].test(text) || val==null) continue;
    if(key==="status"){if(STATES.has(val))out.status=val;continue;}
    if(key==="mode"){if(MODES.has(val))out.mode=val;continue;}
    if(key==="studentGender"){if(["男生","女生","待补充"].includes(val))out.studentGender=val;continue;}
    if(key==="teacherCount"||key==="hoursPerSession"){
      const n=Number(val);if(Number.isFinite(n) && n>0 && n<=(key==="teacherCount"?15:10))out[key]=n;continue;
    }
    if(key==="onlineAllowed"||key==="urgent"){if(typeof val==="boolean")out[key]=val;continue;}
    if(key==="publishedAt"){if(/^\d{4}-\d{2}-\d{2}/.test(str(val)))out[key]=str(val).slice(0,10);continue;}
    if(typeof val!=="string"||val.length>MAX[key]) continue;
    if(key==="salaryText"){
      const nums=[...val.matchAll(/\d{2,4}/g)].map(m=>m[0]);
      if(nums.length && nums.every(n=>text.includes(n)))out[key]=val.trim();
    }else if(key==="publicAddress"){
      if(compact(val).length>0 && compact(text).includes(compact(val))){
        out.publicAddress=val.trim();out.address=val.trim();
      }
    }else if(key==="subject"){
      const subjects=val.split(/[、，,]/).map(compact).filter(Boolean);
      if(subjects.length && subjects.every(s=>compact(text).includes(s)))out.subject=val.trim();
    }else out[key]=val.trim();
  }
  const rate=Number(p?.hourlyRate);
  if(p?.hourlyRate!=null && SIGNAL.salaryText.test(text) && rate>=30 && rate<=1000 &&
    Number.isFinite(rate) && text.includes(String(rate))){
    out.hourlyRate=rate;
    out.salaryText=String(rate)+"元/小时（可报价）";
  }
  if((out.grade||out.subject)&&!out.title)
    out.title=String(out.grade || old.grade || "")+String(out.subject || old.subject || "")+"家教";
  return out;
}
export function guardSiteActions(response,command,orders=[]){
  const text=str(command),actions=[],discarded=[];
  for(const action of (Array.isArray(response?.actions)?response.actions.slice(0,15):[])){
    if(!action||typeof action!=="object")continue;
    const patch=action.patch && typeof action.patch==="object" && !Array.isArray(action.patch)?action.patch:{};
    if(action.type==="update_site"){
      const cleaned=sitePatch(patch,text);
      if(Object.keys(cleaned).length)actions.push({type:"update_site",patch:cleaned});
      else discarded.push("网站字段超出允许范围");
    }else if(action.type==="update_order"){
      const key=str(action.id);
      const old=orders.find(o=>key && (str(o.id)===key || str(o.orderNumber)===key));
      if(!old||![str(old.id),str(old.orderNumber)].some(id=>id && text.includes(id))){
        discarded.push("原始指令或对话中没有确认这个单号");continue;
      }
      const cleaned=orderPatch(patch,text,old);
      if(Object.keys(cleaned).length)actions.push({type:"update_order",id:old.id,patch:cleaned});
      else discarded.push("没有通过字段及原文校验");
    }else discarded.push("拒绝不支持的操作类型");
  }
  return {actions,discarded};
}
