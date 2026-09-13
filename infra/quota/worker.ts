type Env={QUOTA_SERVICE_SECRET:string,AI_QUOTA:{idFromName(name:string):unknown,get(id:unknown):{fetch(request:Request):Promise<Response>}}};
export default {
 async fetch(request:Request,env:Env){
  if(!env.QUOTA_SERVICE_SECRET)return new Response('Unavailable',{status:503});
  if(request.headers.get('Authorization')!==`Bearer ${env.QUOTA_SERVICE_SECRET}`)return new Response('Unauthorized',{status:401});
  if(request.method!=='POST'||new URL(request.url).pathname!=='/claim')return new Response('Not found',{status:404});
  if(Number(request.headers.get('content-length')||0)>256)return new Response('Invalid request',{status:400});
  let caller:unknown;try{const body=await request.text();if(body.length>256)return new Response('Invalid request',{status:400});caller=JSON.parse(body).caller;}catch{return new Response('Invalid request',{status:400});}
  if(typeof caller!=='string'||!/^[a-f0-9]{64}$/.test(caller))return new Response('Invalid caller',{status:400});
  const stub=env.AI_QUOTA.get(env.AI_QUOTA.idFromName('strada-ai-budget'));
  return stub.fetch(new Request('https://quota.internal/claim',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({caller})}));
 }
};
