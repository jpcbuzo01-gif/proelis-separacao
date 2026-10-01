const S=process.env.SUPABASE_URL||"https://mbxmhojgoqzqfxzajafb.supabase.co";
const json=(s,b)=>new Response(JSON.stringify(b),{status:s,headers:{"content-type":"application/json; charset=utf-8"}});
const H=(secret,token)=>({apikey:secret,Authorization:`Bearer ${token}`});
async function admin(token,secret){
 const ur=await fetch(`${S}/auth/v1/user`,{headers:H(secret,token)});if(!ur.ok)return null;const u=await ur.json();
 const pr=await fetch(`${S}/rest/v1/profiles?id=eq.${encodeURIComponent(u.id)}&select=role,ativo`,{headers:H(secret,token)}),p=await pr.json();
 return pr.ok&&p?.[0]?.role==="admin"&&p[0].ativo!==false?u:null;
}
export default async req=>{
 if(req.method!=="POST")return json(405,{error:"Método não permitido"});
 try{
  const secret=process.env.SUPABASE_SECRET_KEY,token=(req.headers.get("authorization")||"").replace(/^Bearer\s+/i,"");
  if(!secret)return json(500,{error:"SUPABASE_SECRET_KEY não configurada."});const user=await admin(token,secret);if(!user)return json(403,{error:"Apenas administradores."});
  const body=await req.json(),ids=Array.isArray(body.ids)?body.ids.slice(0,12):[];
  if(!ids.length)return json(400,{error:"Lote vazio."});
  let copied=0,existing=0,failed=0,no_url=0;const errors=[];
  for(const id of ids){
   try{
    const pr=await fetch(`${S}/rest/v1/products?id=eq.${encodeURIComponent(id)}&select=id,referencia,especificacoes`,{headers:H(secret,token)}),pa=await pr.json(),p=pa?.[0];
    if(!p){failed++;continue}
    const er=await fetch(`${S}/rest/v1/product_images?product_id=eq.${p.id}&select=id&limit=1`,{headers:H(secret,token)}),ei=await er.json();
    if(ei?.length){existing++;continue}
    const url=p.especificacoes?.csv_image_url;if(!url){no_url++;continue}
    const im=await fetch(url,{headers:{"user-agent":"Mozilla/5.0 ProelisCatalogPhotoSync/1.0"},signal:AbortSignal.timeout(7000)});
    if(!im.ok)throw new Error(`imagem HTTP ${im.status}`);
    const ct=(im.headers.get("content-type")||"image/jpeg").split(";")[0];
    if(!ct.startsWith("image/"))throw new Error(`conteúdo não é imagem (${ct})`);
    const bytes=await im.arrayBuffer();if(bytes.byteLength>8_000_000)throw new Error("imagem maior que 8 MB");
    const ext=ct.includes("png")?"png":ct.includes("webp")?"webp":ct.includes("gif")?"gif":"jpg";
    const path=`csv/${p.referencia}/${Date.now()}.${ext}`;
    const up=await fetch(`${S}/storage/v1/object/product-images/${path}`,{method:"POST",headers:{apikey:secret,"content-type":ct,"x-upsert":"false"},body:bytes});
    if(!up.ok)throw new Error(`Storage ${up.status}: ${(await up.text()).slice(0,120)}`);
    const ir=await fetch(`${S}/rest/v1/product_images`,{method:"POST",headers:{...H(secret,token),"content-type":"application/json"},body:JSON.stringify({product_id:p.id,storage_path:path,origem:"site_proelis",url_origem:url,principal:true,created_by:user.id})});
    if(!ir.ok){await fetch(`${S}/storage/v1/object/product-images/${path}`,{method:"DELETE",headers:{apikey:secret}});throw new Error(`registro ${ir.status}`)}
    copied++;
   }catch(e){failed++;if(errors.length<5)errors.push(`${id}: ${e.message||e}`)}
  }
  return json(200,{ok:true,total:ids.length,copied,existing,failed,no_url,errors});
 }catch(e){return json(500,{error:e?.message||String(e)})}
};
