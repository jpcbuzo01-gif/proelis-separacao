const BASE="https://www.proelis.com.br/";
const json=(status,body)=>new Response(JSON.stringify(body),{status,headers:{"content-type":"application/json; charset=utf-8"}});
const clean=s=>(s||"").replace(/<[^>]*>/g," ").replace(/&nbsp;/gi," ").replace(/&amp;/gi,"&").replace(/\s+/g," ").trim();
function abs(href,base){try{const u=new URL(href,base);if(!/(^|\.)proelis\.com\.br$/i.test(u.hostname))return null;u.hash="";return u.href}catch{return null}}
function refFrom(h){
  const patterns=[
    /Refer[eê]ncia\s*:?\s*<\/?[^>]*>\s*([0-9]{1,10})/i,
    /Refer[eê]ncia\s*:\s*([0-9]{1,10})/i,
    /Refer[eê]ncia[\s\S]{0,120}?([0-9]{1,10})/i
  ];
  for(const p of patterns){const m=h.match(p);if(m)return m[1]} return null;
}
function titleFrom(h){let m=h.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i)||h.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)||h.match(/<title[^>]*>([\s\S]*?)<\/title>/i);return m?clean(m[1]):null}
function linksFrom(h,url){
  const out=[];for(const m of h.matchAll(/<a\b[^>]*href=["']([^"'#]+)["']/gi)){const u=abs(m[1],url);if(!u)continue;
    const x=new URL(u);if(!/\.php(?:$|\?)/i.test(x.pathname+x.search))continue;
    if(/(?:contato|empresa|localizacao|parceiros|trabalhe|sistema-de-entrega|tabela|carrinho|login|politica|privacidade)/i.test(x.pathname))continue;
    if(!out.includes(u))out.push(u);
  }return out;
}
async function admin(token,secret){
 const ur=await fetch(`${process.env.SUPABASE_URL||"https://mbxmhojgoqzqfxzajafb.supabase.co"}/auth/v1/user`,{headers:{apikey:secret,Authorization:`Bearer ${token}`}});
 if(!ur.ok)return false;const u=await ur.json();
 const pr=await fetch(`${process.env.SUPABASE_URL||"https://mbxmhojgoqzqfxzajafb.supabase.co"}/rest/v1/profiles?id=eq.${encodeURIComponent(u.id)}&select=role,ativo`,{headers:{apikey:secret,Authorization:`Bearer ${token}`}});
 const p=await pr.json();return pr.ok&&p?.[0]?.role==="admin"&&p[0].ativo!==false;
}
export default async req=>{
 if(req.method!=="POST")return json(405,{error:"Método não permitido"});
 try{
  const secret=process.env.SUPABASE_SECRET_KEY;if(!secret)return json(500,{error:"SUPABASE_SECRET_KEY não configurada."});
  const token=(req.headers.get("authorization")||"").replace(/^Bearer\s+/i,"");if(!token||!(await admin(token,secret)))return json(403,{error:"Apenas administradores podem sincronizar o catálogo."});
  const seen=new Set(),queue=[BASE],products=new Map();let fetched=0;
  // Bounded crawl: enough for site navigation/category/product links without runaway.
  while(queue.length&&fetched<450){
    const url=queue.shift();if(seen.has(url))continue;seen.add(url);
    let r;try{r=await fetch(url,{headers:{"user-agent":"Mozilla/5.0 ProelisCatalogSync/1.0"}})}catch{continue}
    if(!r.ok)continue;const h=await r.text();fetched++;
    const ref=refFrom(h);
    if(ref&&!products.has(ref))products.set(ref,{referencia:ref,nome:titleFrom(h),url});
    // crawl home/category/product pages; cap queue
    for(const u of linksFrom(h,url)){if(!seen.has(u)&&queue.length<900)queue.push(u)}
  }
  return json(200,{ok:true,pages_scanned:fetched,products:[...products.values()]});
 }catch(e){return json(500,{error:e?.message||String(e)})}
};
