// Fixed durations remain numbers for old orders; genuine intervals are canonical strings.
export function parseOrderDuration(value) {
  const s=String(value??"").normalize("NFKC").trim();
  if(/^(?:待协商|待补充|待确认|未提供|不确定|时长待协商)$/.test(s))return "待协商";
  const m=s.match(/^(?:每次|单次)?\s*(\d+(?:\.\d+)?)\s*(?:小时)?\s*(?:[~～—–－\-至到]\s*(\d+(?:\.\d+)?)\s*(?:小时)?)?\s*[。.]?$/);
  if(!m)return null;
  const lo=Number(m[1]),hi=m[2]===undefined?lo:Number(m[2]);
  if(!(lo>0&&hi>=lo&&hi<=24))return null;
  return lo===hi?lo:lo+"～"+hi;
}
export function durationLabel(value) {
  const d=parseOrderDuration(value);
  return d===null||d==="待协商"?"时长待协商":d+"小时";
}
// Only recover explicitly marked, standalone per-session statements. Never infer duration from
// a clock window, a trial lesson, hourly salary, or an unrelated number in the notes.
export function reconcileOrderDuration(value, notes) {
  let duration=parseOrderDuration(value), conflict=false;
  const original=String(notes??"").trim();
  const segments=original.split(/([；;。！\n])/);
  const candidates=[];
  for(let i=0;i<segments.length;i+=2){
    const part=segments[i].trim();
    if(!/^(?:每次|单次)\s*\d/.test(part))continue;
    const d=parseOrderDuration(part);
    if(d!==null&&d!=="待协商"&&/小时/.test(part))candidates.push({i,d});
  }
  const bounds=d=>String(d).split("～").map(Number);
  const compatible=(a,b)=>{
    if(a===b)return true;
    const x=bounds(a),y=bounds(b);
    return x.length===1&&y.length===2&&x[0]>=y[0]&&x[0]<=y[1];
  };
  const distinct=[...new Set(candidates.map(x=>x.d))];
  if(distinct.length>1)conflict=true;
  else if(distinct.length===1){
    const d=distinct[0];
    if(duration===null||duration==="待协商"||compatible(duration,d)){
      duration=d;
      for(const {i} of candidates){segments[i]="";if(i+1<segments.length)segments[i+1]="";else if(i>0)segments[i-1]="";}
    }else if(compatible(d,duration)){
      for(const {i} of candidates){segments[i]="";if(i+1<segments.length)segments[i+1]="";else if(i>0)segments[i-1]="";}
    }else conflict=true;
  }
  return {duration:duration??"待协商",notes:segments.join("").trim(),conflict};
}
