const BASE="https://www.proelis.com.br/";
const json=(s,b)=>new Response(JSON.stringify(b),{status:s,headers:{"content-type":"application/json; charset=utf-8"}});
const clean=s=>(s||"").replace(/<[^>]*>/g," ").replace(/&nbsp;/gi," ").replace(/&amp;/gi,"&").replace(/\s+/g," ").trim();
function norm(href,base){try{const u=new URL(href,base);if(!/(^|\.)proelis\.com\.br$/i.test(u.hostname))return null;u.hash="";u.search="";if(u.pathname==="/index.php")u.pathname="/";return u.href}catch{return null}}
function refFrom(h){const t=clean(h);const m=t.match(/Refer[eê]ncia\s*:?\s*([0-9]{1,10})/i);return m?m[1]:null}
function titleFrom(h){const m=h.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i)||h.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)||h.match(/<title[^>]*>([\s\S]*?)<\/title>/i);return m?clean(m[1]):null}
function links(h,url){
 const out=[];
 for(const m of h.matchAll(/<a\b[^>]*href=["']([^"'#]+)["']/gi)){
  const u=norm(m[1],url);if(!u)continue;const p=new URL(u).pathname;
  if(!(/\.php$/i.test(p)||p==="/"))continue;
  if(/(?:contato|empresa|localizacao|parceiros|trabalhe|sistema-de-entrega|carrinho|login|politica|privacidade|promoco|oferta)/i.test(p))continue;
  if(!out.includes(u))out.push(u);
 } return out;
}
async function isAdmin(token,secret){
 const S=process.env.SUPABASE_URL||"https://mbxmhojgoqzqfxzajafb.supabase.co";
 const ur=await fetch(`${S}/auth/v1/user`,{headers:{apikey:secret,Authorization:`Bearer ${token}`}});if(!ur.ok)return false;
 const u=await ur.json(),pr=await fetch(`${S}/rest/v1/profiles?id=eq.${encodeURIComponent(u.id)}&select=role,ativo`,{headers:{apikey:secret,Authorization:`Bearer ${token}`}});
 const p=await pr.json();return pr.ok&&p?.[0]?.role==="admin"&&p[0].ativo!==false;
}
export default async req=>{
 if(req.method!=="POST")return json(405,{error:"Método não permitido"});
 try{
  const secret=process.env.SUPABASE_SECRET_KEY;if(!secret)return json(500,{error:"SUPABASE_SECRET_KEY não configurada."});
  const token=(req.headers.get("authorization")||"").replace(/^Bearer\s+/i,"");if(!token||!(await isAdmin(token,secret)))return json(403,{error:"Apenas administradores podem sincronizar o catálogo."});
  let b={};try{b=await req.json()}catch{}
  const queue=Array.isArray(b.queue)?b.queue:[BASE],seen=new Set(Array.isArray(b.seen)?b.seen:[]),products=new Map((Array.isArray(b.found)?b.found:[]).map(x=>[String(x.referencia),x]));
  let processed=0;const BATCH=20;
  while(queue.length&&processed<BATCH){
   const url=queue.shift();if(seen.has(url))continue;seen.add(url);processed++;
   let r;try{r=await fetch(url,{headers:{"user-agent":"Mozilla/5.0 ProelisCatalogSync/1.2"},signal:AbortSignal.timeout(4500)})}catch{continue}
   if(!r.ok)continue;const h=await r.text(),ref=refFrom(h);
   if(ref){if(!products.has(String(ref)))products.set(String(ref),{referencia:String(ref),nome:titleFrom(h),url});continue} // product pages are leaves
   for(const u of links(h,url))if(!seen.has(u)&&!queue.includes(u)&&queue.length<2500)queue.push(u);
  }
  return json(200,{ok:true,done:queue.length===0,processed,scanned:seen.size,pending:queue.length,queue,seen:[...seen],found:[...products.values()]});
 }catch(e){return json(500,{error:e?.message||String(e)})}
};
