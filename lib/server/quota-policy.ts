export type QuotaState={day:string,total:number,callers:Record<string,{at:number,count:number}>};
export function allocateQuota(previous:QuotaState|undefined,caller:string,now:number,dailyLimit=50){
 const day=new Date(now).toISOString().slice(0,10);const state:QuotaState=previous?.day===day?structuredClone(previous):{day,total:0,callers:{}};
 if(state.total>=dailyLimit)return {allowed:false,code:'DAILY_LIMIT',state};
 const prior=state.callers[caller];const bucket=prior&&now-prior.at<600000?prior:{at:now,count:0};
 if(bucket.count>=6)return {allowed:false,code:'RATE_LIMIT',state};
 state.total++;state.callers[caller]={...bucket,count:bucket.count+1};return {allowed:true,code:'OK',state};
}
