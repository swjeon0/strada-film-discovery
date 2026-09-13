import {AppError} from './config';
export async function claimPublicQuota(ip:string){
 if(process.env.PUBLIC_MODE!=='true'&&process.env.VERCEL!=='1')return;
 const endpoint=process.env.QUOTA_SERVICE_URL,secret=process.env.QUOTA_SERVICE_SECRET;
 if(!endpoint?.startsWith('https://')||!secret)throw new AppError('SETUP_REQUIRED','Public AI quota is not configured.',503);
 const day=new Date().toISOString().slice(0,10);const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(day+':'+ip));const caller=Array.from(new Uint8Array(bytes),x=>x.toString(16).padStart(2,'0')).join('');
 let response:Response;
 try{response=await fetch(endpoint,{method:'POST',redirect:'error',headers:{Authorization:`Bearer ${secret}`,'Content-Type':'application/json'},body:JSON.stringify({caller}),signal:AbortSignal.timeout(6000),cache:'no-store'});}
 catch{throw new AppError('QUOTA_UNAVAILABLE','The discovery budget could not be checked. Please try again shortly.',503);}
 if(!response.ok){
  if(response.status===429){const result=await response.json() as {code?:string};throw new AppError(result.code==='DAILY_LIMIT'?'DAILY_LIMIT':'RATE_LIMIT','The discovery limit has been reached. Your path is safe.',429);}
  throw new AppError('QUOTA_UNAVAILABLE','The discovery budget could not be checked. Please try again shortly.',503);
 }
}
