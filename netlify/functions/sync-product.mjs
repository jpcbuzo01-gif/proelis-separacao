const SUPABASE_URL = "https://mbxmhojgoqzqfxzajafb.supabase.co";

const json = (statusCode, body) => ({
  statusCode,
  headers: {"content-type":"application/json; charset=utf-8"},
  body: JSON.stringify(body)
});

function absUrl(src, pageUrl){
  try { return new URL(src, pageUrl).href; } catch { return null; }
}
function clean(s=""){
  return s.replace(/<[^>]*>/g," ").replace(/&nbsp;/g," ").replace(/&amp;/g,"&")
    .replace(/&#(\d+);/g,(_,n)=>String.fromCharCode(Number(n))).replace(/\s+/g," ").trim();
}
function pick(html, re){
  const m=html.match(re); return m ? clean(m[1]) : null;
}
function safeName(url, i){
  let ext=".jpg";
  try {
    const p=new URL(url).pathname.toLowerCase();
    const m=p.match(/\.(jpg|jpeg|png|webp)(?:$)/); if(m) ext="."+m[1].replace("jpeg","jpg");
  } catch {}
  return `${Date.now()}-${i}${ext}`;
}

export default async (req) => {
  if(req.method !== "POST") return json(405,{error:"Método não permitido"});
  try{
    const secret=process.env.SUPABASE_SECRET_KEY;
    if(!secret) return json(500,{error:"SUPABASE_SECRET_KEY não configurada no Netlify."});

    const auth=req.headers.get("authorization")||"";
    const token=auth.replace(/^Bearer\s+/i,"");
    if(!token) return json(401,{error:"Sessão ausente."});

    // Confirma usuário autenticado
    const ur=await fetch(`${SUPABASE_URL}/auth/v1/user`,{
      headers:{apikey:secret,Authorization:`Bearer ${token}`}
    });
    if(!ur.ok) return json(401,{error:"Sessão inválida."});
    const user=await ur.json();

    // Confirma perfil administrador usando o JWT do próprio usuário
    const pr=await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(user.id)}&select=role,ativo`,{
      headers:{apikey:secret,Authorization:`Bearer ${token}`}
    });
    const profiles=await pr.json();
    if(!pr.ok || !profiles?.[0] || profiles[0].role!=="admin" || profiles[0].ativo===false)
      return json(403,{error:"Apenas administradores podem sincronizar o catálogo."});

    const body=await req.json();
    const {product_id,referencia,url}=body||{};
    if(!product_id||!referencia||!url) return json(400,{error:"Produto, referência e URL são obrigatórios."});
    const u=new URL(url);
    if(!/(^|\.)proelis\.com\.br$/i.test(u.hostname)) return json(400,{error:"A URL deve ser do site proelis.com.br."});

    const page=await fetch(url,{headers:{"user-agent":"Mozilla/5.0 ProelisCatalogSync/1.0"}});
    if(!page.ok) return json(502,{error:`O site Proelis respondeu HTTP ${page.status}.`});
    const h=await page.text();

    const pageRef=pick(h,/Refer[eê]ncia\s*:?\s*<\/?[^>]*>\s*([0-9]+)/i) ||
                  pick(h,/Refer[eê]ncia\s*:\s*([0-9]+)/i);
    if(pageRef && String(pageRef)!==String(referencia))
      return json(400,{error:`A página é da referência ${pageRef}, mas o produto aberto é ${referencia}.`});

    const title=pick(h,/<h3[^>]*>([\s\S]*?)<\/h3>/i) || pick(h,/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    const brand=pick(h,/Marca\s*:?\s*<\/?[^>]*>\s*([^<\r\n]+)/i) || pick(h,/Marca\s*:\s*([^<\r\n]+)/i);
    const manufacturer=pick(h,/Fabricante\s*:\s*([^<\r\n]+)/i);
    const model=pick(h,/Modelo(?:\s+do\s+Rolamento)?\s*:\s*([^<\r\n]+)/i);
    const measures=pick(h,/(?:Di[aâ]metro\s*x\s*Largura\s*x\s*Furo[^:]*|Medidas?)\s*:\s*([^<\r\n]+)/i);

    // Fotos: prioriza imagens cujo alt tenha o modelo/nome do produto.
    const imgs=[];
    const imgRe=/<img\b[^>]*>/gi;
    for(const tag of h.match(imgRe)||[]){
      const sm=tag.match(/\bsrc=["']([^"']+)["']/i); if(!sm) continue;
      const alt=(tag.match(/\balt=["']([^"']*)["']/i)||[])[1]||"";
      const src=absUrl(sm[1],url); if(!src) continue;
      if(!/\.(jpe?g|png|webp)(?:\?|$)/i.test(src)) continue;
      const relevant=(model && alt.toLowerCase().includes(String(model).toLowerCase())) ||
                     (title && alt && title.toLowerCase().includes(alt.toLowerCase())) ||
                     /rolamento|produto/i.test(alt);
      if(relevant && !imgs.includes(src)) imgs.push(src);
    }
    // og:image como fallback
    const og=(h.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)||
              h.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i)||[])[1];
    if(og){const a=absUrl(og,url);if(a&&!imgs.includes(a))imgs.unshift(a)}
    const selected=imgs.slice(0,6);

    // Atualiza somente metadados de sincronização e campos vazios.
    // Não sobrescreve alterações administrativas existentes.
    const getProd=await fetch(`${SUPABASE_URL}/rest/v1/products?id=eq.${encodeURIComponent(product_id)}&select=*`,{
      headers:{apikey:secret,Authorization:`Bearer ${token}`}
    });
    const prods=await getProd.json(); const p=prods?.[0];
    if(!p) return json(404,{error:"Produto não encontrado no catálogo."});
    const patch={
      last_sync_at:new Date().toISOString(),
      site_updated_at:new Date().toISOString(),
      url_origem:url,
      origem:p.origem==="manual"?"misto":p.origem
    };
    if(!p.nome && title) patch.nome=title;
    if(!p.marca && brand) patch.marca=brand;
    if(!p.fabricante && manufacturer) patch.fabricante=manufacturer;
    if(!p.modelo && model) patch.modelo=model;
    if(!p.medidas && measures) patch.medidas=measures;

    const up=await fetch(`${SUPABASE_URL}/rest/v1/products?id=eq.${encodeURIComponent(product_id)}`,{
      method:"PATCH",
      headers:{apikey:secret,Authorization:`Bearer ${token}`,"content-type":"application/json",Prefer:"return=minimal"},
      body:JSON.stringify(patch)
    });
    if(!up.ok) return json(500,{error:"Falha ao atualizar metadados do produto.",detail:await up.text()});

    // Fotos já registradas pelo site para não duplicar.
    const exr=await fetch(`${SUPABASE_URL}/rest/v1/product_images?product_id=eq.${encodeURIComponent(product_id)}&origem=eq.site_proelis&select=url_origem,storage_path`,{
      headers:{apikey:secret,Authorization:`Bearer ${token}`}
    });
    const existing=exr.ok?await exr.json():[];
    const known=new Set((existing||[]).map(x=>x.url_origem).filter(Boolean));
    let saved=0;

    for(let i=0;i<selected.length;i++){
      const imageUrl=selected[i]; if(known.has(imageUrl)) continue;
      const ir=await fetch(imageUrl,{headers:{"user-agent":"Mozilla/5.0 ProelisCatalogSync/1.0"}});
      if(!ir.ok) continue;
      const contentType=ir.headers.get("content-type")||"image/jpeg";
      if(!contentType.startsWith("image/")) continue;
      const bytes=await ir.arrayBuffer();
      const path=`${referencia}/site/${safeName(imageUrl,i)}`;

      const sr=await fetch(`${SUPABASE_URL}/storage/v1/object/product-images/${path}`,{
        method:"POST",
        headers:{apikey:secret,"content-type":contentType,"x-upsert":"false"},
        body:bytes
      });
      if(!sr.ok) continue;

      const row={product_id,storage_path:path,origem:"site_proelis",url_origem:imageUrl,principal:(existing.length===0 && saved===0),ordem:i,created_by:user.id};
      const rr=await fetch(`${SUPABASE_URL}/rest/v1/product_images`,{
        method:"POST",
        headers:{apikey:secret,Authorization:`Bearer ${token}`,"content-type":"application/json",Prefer:"return=minimal"},
        body:JSON.stringify(row)
      });
      if(rr.ok) saved++;
      else await fetch(`${SUPABASE_URL}/storage/v1/object/product-images/${path}`,{method:"DELETE",headers:{apikey:secret}});
    }

    return json(200,{ok:true,reference:referencia,photos_found:selected.length,photos_saved:saved,title,brand,manufacturer,model,measures});
  }catch(e){
    return json(500,{error:e?.message||String(e)});
  }
};
