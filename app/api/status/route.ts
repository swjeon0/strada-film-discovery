import {config} from '@/lib/server/config';
import {knowledgeRepository} from '@/lib/server/knowledge/corpus';
import {PRODUCTION_CURATOR_SETTINGS} from '@/lib/server/curator-production';
export async function GET(){const c=config();return Response.json({mode:c.openai?'live':'collection',filmSearch:true,discovery:!!c.openai,metadataProvider:c.tmdb?'tmdb':'wikimedia',collectionSize:16,engine:'curator-literature-v2',model:PRODUCTION_CURATOR_SETTINGS.model,knowledge:knowledgeRepository().stats()},{headers:{'Cache-Control':'no-store'}});}
