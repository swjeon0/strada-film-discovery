import {config} from '@/lib/server/config';
export async function GET(){const c=config();return Response.json({mode:c.openai&&c.tmdb?'live':'collection',filmSearch:!!c.tmdb,discovery:!!c.openai&&!!c.tmdb,collectionSize:16},{headers:{'Cache-Control':'no-store'}});}
