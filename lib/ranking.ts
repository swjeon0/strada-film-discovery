import {weights,type Film,type Recommendation} from './domain';
const quality={direct_connection:1,grounded_interpretation:.8,curatorial_association:.62};
export function connectionScore(rec:Recommendation,seeds:Film[],trail:Film[]){
 const w=new Map(weights(seeds,trail).map(x=>[x.film.id,x.weight]));
 const anchors=new Map<string,number>();for(const c of rec.connections)if(w.has(c.anchorId))anchors.set(c.anchorId,Math.max(anchors.get(c.anchorId)??0,quality[c.relation]));
 const relevance=[...anchors].reduce((sum,[id,q])=>sum+(w.get(id)??0)*q,0);
 return relevance*(1+.06*Math.min(2,Math.max(0,anchors.size-1)));
}
function similarity(a:Film,b:Film){let score=0;if(a.director&&a.director===b.director)score+=.45;if(a.country&&a.country===b.country)score+=.2;if(Math.floor(a.year/10)===Math.floor(b.year/10))score+=.15;if(a.genres?.some(g=>b.genres?.includes(g)))score+=.2;return score;}
export function rankRecommendations(recs:Recommendation[],seeds:Film[],trail:Film[],seenIds:string[]=[],limit=12){
 const excluded=new Set([...seeds,...trail].map(f=>f.id));const unique=[...new Map(recs.filter(r=>!excluded.has(r.film.id)).map(r=>[r.film.id,r])).values()];
 const base=new Map(unique.map(r=>[r.film.id,connectionScore(r,seeds,trail)]));const max=Math.max(...base.values(),.0001);const seen=new Set(seenIds);const chosen:Recommendation[]=[];
 while(unique.length&&chosen.length<limit){unique.sort((a,b)=>{const value=(r:Recommendation)=>{const relevance=(base.get(r.film.id)??0)/max;const redundancy=chosen.length?Math.max(...chosen.map(s=>similarity(r.film,s.film))):0;return relevance*(1-.22*redundancy)-(seen.has(r.film.id)?.025:0);};return value(b)-value(a)||a.film.id.localeCompare(b.film.id);});chosen.push(unique.shift()!);}
 return chosen;
}
