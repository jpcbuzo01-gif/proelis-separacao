const BASE="https://www.proelis.com.br/";
const json=(status,body)=>new Response(JSON.stringify(body),{status,headers:{"content-type":"application/json; charset=utf-8"}});
const clean=s=>(s||"").replace(/<[^>]*>/g," ").replace(/&nbsp;/gi," ").replace(/&amp;/gi,"&").replace(/\s+/g," ").trim();
function abs(href,base){try{const u=new URL(href,base);if(!/(^|\.)proelis\.com\.br$/i.test(u.hostname))return null;u.hash="";return u.href}catch{return null}}
function refFrom(h){for(const p of [/Refer[eê]ncia\s*:?\s*<\/?[^>]*>\s*([0-9]{1,10})/i,/Refer[eê]ncia\s*:\s*([0-9]{1,10})/i,/Refer[eê]ncia[\s\S]{0,120}?([0-9]{1,10})/i]){const m=h.match(p);if(m)return m[1]}return null}
function titleFrom(h){const m=h.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i)||h.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)||h.match(/<title[^>]*>([\s\S]*?)<\/title>/i);return m?clean(m[1]):null}
function linksFrom(h,url){const out=[];for(const m of h.matchAll(/<a\b[^>]*href=["']([^"'#]+)["']/gi)){const u=abs(m[1],url);if(!u)continue;const x=new URL(u);if(!/\.php(?:$|\?)/i.test(x.pathname+x.search))continue;if(/(?:contato|empresa|localizacao|parceiros|trabalhe|sistema-de-entrega|tabela|carrinho|login|politica|privacidade)/i.test(x.pathname))continue;if(!out.includes(u))out.push(u)}return out}
async function admin(token,secret){
 const S=process.env.SUPABASE_URL||"https://mbxmhojgoqzqfxzajafb.supabase.co";
 const ur=await fetch(`${S}/auth/v1/user`,{headers:{apikey:secret,Authorization:`Bearer ${token}`}});if(!ur.ok)return false;
 const u=await ur.json();const pr=await fetch(`${S}/rest/v1/profiles?id=eq.${encodeURIComponent(u.id)}&select=role,ativo`,{headers:{apikey:secret,Authorization:`Bearer ${token}`}});
 const p=await pr.json();return pr.ok&&p?.[0]?.role==="admin"&&p[0].ativo!==false;
}
export default async req=>{
 if(req.method!=="POST")return json(405,{error:"Método não permitido"});
 try{
  const secret=process.env.SUPABASE_SECRET_KEY;if(!secret)return json(500,{error:"SUPABASE_SECRET_KEY não configurada."});
  const token=(req.headers.get("authorization")||"").replace(/^Bearer\s+/i,"");if(!token||!(await admin(token,secret)))return json(403,{error:"Apenas administradores podem sincronizar o catálogo."});
  let body={};try{body=await req.json()}catch{}
  let queue=Array.isArray(body.queue)?body.queue:[BASE], seen=Array.isArray(body.seen)?body.seen:[], found=Array.isArray(body.found)?body.found:[];
  const seenSet=new Set(seen), foundMap=new Map(found.map(x=>[String(x.referencia),x]));
  const BATCH=8; let processed=0;
  while(queue.length&&processed<BATCH){
    const url=queue.shift();if(seenSet.has(url))continue;seenSet.add(url);
    let r;try{r=await fetch(url,{headers:{"user-agent":"Mozilla/5.0 ProelisCatalogSync/1.1"},signal:AbortSignal.timeout(7000)})}catch{processed++;continue}
    if(r.ok){
      const h=await r.text();const ref=refFrom(h);if(ref&&!foundMap.has(String(ref)))foundMap.set(String(ref),{referencia:String(ref),nome:titleFrom(h),url});
      for(const u of linksFrom(h,url))if(!seenSet.has(u)&&!queue.includes(u)&&queue.length<1000)queue.push(u);
    }
    processed++;
  }
  return json(200,{ok:true,done:queue.length===0,processed,scanned:seenSet.size,queue,seen:[...seenSet],found:[...foundMap.values()]});
 }catch(e){return json(500,{error:e?.message||String(e)})}
};
