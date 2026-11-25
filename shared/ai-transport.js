// Read-only inference calls; never retry a publishing or storage operation.
// A single bounded retry for an early, transient upstream failure.
const transient=new Set([502,503,504,520,521,522,523,524]);
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export class AITransportError extends Error{
 constructor(message,code,status=502){super(message);this.code=code;this.status=status;}
}
export function safeProviderDetail(value,secret=""){
 let s=String(value||"接口未返回可用结果");
 if(secret)s=s.split(secret).join("[密钥已隐藏]");
 return s.replace(/https?:\/\/[^\s"'<>]+/gi,"[上游网址已隐藏]")
  .replace(/(?:Bearer\s+|sk-)[A-Za-z0-9_.-]+/gi,"[密钥已隐藏]")
  .replace(/[\r\n\t]/g," ").slice(0,240);
}
export async function requestAIJSON(url,options,{provider="模型服务",secret="",allowRetry=true,fetcher=fetch,sleep=pause,clock=Date.now}={}){
 const start=clock(),budget=78000;
 for(let attempt=0;attempt<2;attempt++){
  const remaining=budget-(clock()-start);
  if(remaining<=0)throw new AITransportError(provider+" 响应超时，请减少单次输入或切换更快的模型","AI_UPSTREAM_TIMEOUT",504);
  let response,data,error;
  try{
   response=await fetcher(url,{...options,signal:AbortSignal.timeout(Math.min(65000,remaining))});
   const raw=await response.text();
   try{data=JSON.parse(raw);}catch{
    error=new AITransportError(provider+" 中转站返回非 JSON（HTTP "+response.status+"）","AI_UPSTREAM_NON_JSON",transient.has(response.status)?502:500);
   }
   if(!error&&(!response.ok||data?.error)){
    const detail=safeProviderDetail(data?.error?.message||data?.error?.msg||data?.message,secret);
    error=new AITransportError(provider+" HTTP "+response.status+"："+detail,transient.has(response.status)?"AI_UPSTREAM_GATEWAY":"AI_UPSTREAM_REJECTED",transient.has(response.status)?502:500);
   }
   if(!error)return data;
  }catch(e){
   const timeout=e?.name==="TimeoutError"||e?.name==="AbortError";
   error=new AITransportError(provider+(timeout?" 响应超时，请减少单次输入或切换更快的模型":" 网络连接异常，请稍后重试或检查中转站"),timeout?"AI_UPSTREAM_TIMEOUT":"AI_UPSTREAM_NETWORK",timeout?504:502);
  }
  // Do not repeat late/expensive calls, quota errors, authentication errors, or public recommendations.
  const early=clock()-start<15000;
  if(attempt===0&&allowRetry&&early&&(transient.has(response?.status)||error.code==="AI_UPSTREAM_NETWORK")){
    console.warn("[ai-upstream] early transient failure; retrying once",error.code,response?.status||0);
    await sleep(800);continue;
  }
  throw error;
 }
}
