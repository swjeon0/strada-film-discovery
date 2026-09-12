import {config} from '@/lib/server/config';
export async function GET(){const c=config();return Response.json({mode:c.openai?'live':'collection',filmSearch:true,discovery:!!c.openai,metadataProvider:c.tmdb?'tmdb':'wikimedia',collectionSize:16},{headers:{'Cache-Control':'no-store'}});}
