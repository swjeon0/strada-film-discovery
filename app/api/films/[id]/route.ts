import {getFilm} from '@/lib/server/tmdb';
import {errorResponse} from '@/lib/server/config';
export async function GET(_r:Request,{params}:{params:Promise<{id:string}>}){try{const {id}=await params;return Response.json({film:await getFilm(id)});}catch(e){return errorResponse(e)}}
