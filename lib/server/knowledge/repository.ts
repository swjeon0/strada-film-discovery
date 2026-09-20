import type {Film,Language} from '../../domain';
import type {ContextBundle} from '../curator-v1/contract';

export interface KnowledgeRepository{
 buildContext(selected:Film[],language:Language):Promise<ContextBundle>;
 fingerprint():string;
}

