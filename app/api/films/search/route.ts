import {searchCollection} from '@/lib/catalogue';
import {config,errorResponse,AppError} from '@/lib/server/config';
import {searchTMDB} from '@/lib/server/tmdb';
export async function GET(r:Request){try{const q=(new URL(r.url).searchParams.get('q')??'').trim();if(q.length>100)throw new AppError('INVALID_QUERY','Use a shorter film title.',400);const c=config();const live=c.tmdb&&c.openai;if(!live)return Response.json({films:searchCollection(q),mode:'collection'});if(q.length<2)return Response.json({films:searchCollection(q),mode:'live'});const films=await searchTMDB(q);return Response.json({films,mode:'live'});}catch(e){return errorResponse(e)}}
