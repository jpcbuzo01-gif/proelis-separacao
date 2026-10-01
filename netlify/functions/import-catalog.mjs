const S=process.env.SUPABASE_URL||"https://mbxmhojgoqzqfxzajafb.supabase.co";
const json=(s,b)=>new Response(JSON.stringify(b),{status:s,headers:{"content-type":"application/json; charset=utf-8"}});
const H=(secret,token)=>({apikey:secret,Authorization:`Bearer ${token}`});
const clean=s=>(s??"").toString().trim();
const key=s=>clean(s).normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/[^a-z0-9]/gi,"").toLowerCase();
const val=(row,...names)=>{
  const map={}; for(const [k,v] of Object.entries(row)) map[key(k)]=v;
  for(const n of names){const v=map[key(n)]; if(v!==undefined)return clean(v)}
  return "";
};
function parseCSV(text){
 const lines=text.replace(/^\uFEFF/,"").split(/\r?\n/).filter(x=>x.trim()); if(!lines.length)return [];
 const delim=(lines[0].split(";").length>lines[0].split(",").length)?";":",";
 function row(line){let a=[],v="",q=false;for(let i=0;i<line.length;i++){const c=line[i];if(c=='"'){if(q&&line[i+1]=='"'){v+='"';i++}else q=!q}else if(c===delim&&!q){a.push(v);v=""}else v+=c}a.push(v);return a}
 const head=row(lines[0]).map(clean);return lines.slice(1).map(l=>{const a=row(l),o={};head.forEach((h,i)=>o[h]=clean(a[i]));return o});
}
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
  const fd=await req.formData(),file=fd.get("file");if(!file)return json(400,{error:"Envie o CSV."});
  const rows=parseCSV(await file.text());
  if(!rows.length)return json(400,{error:"O CSV está vazio ou não pôde ser lido."});
  const normalizedHeaders=Object.keys(rows[0]).map(key);
  if(!normalizedHeaders.includes("referencia")){
    return json(400,{error:"Coluna de Referência não encontrada no CSV.",headers:Object.keys(rows[0])});
  }
  let created=0,updated=0,skipped=0,photos=0,errors=0;
  for(const r of rows){
   const ref=val(r,"Referência","Referencia");if(!ref){skipped++;continue}
   const name=val(r,"Nome produto")||`Produto REF. ${ref}`,brand=val(r,"Marca"),cat=val(r,"Nome categoria");
   const c=val(r,"Comprimento"),w=val(r,"Largura"),h=val(r,"Altura");
   const medidas=[c,w,h].filter(Boolean).join(" × ");
   let grams=parseFloat(val(r,"Peso em gramas").replace(",", "."));let kg=Number.isFinite(grams)?grams/1000:null;
   const qr=await fetch(`${S}/rest/v1/products?referencia=eq.${encodeURIComponent(ref)}&select=*`,{headers:H(secret,token)}),arr=await qr.json();let p=arr?.[0];
   if(!p){
    const body={referencia:ref,nome:name,descricao:name,categoria:cat||null,marca:brand||null,peso_kg:kg,medidas:medidas||null,origem:"misto",created_by:user.id,updated_by:user.id};
    const ir=await fetch(`${S}/rest/v1/products`,{method:"POST",headers:{...H(secret,token),"content-type":"application/json","prefer":"return=representation"},body:JSON.stringify(body)});
    if(!ir.ok){errors++;continue}p=(await ir.json())[0];created++;
   }else{
    // Fill only empty fields: manual/admin values retain priority.
    const patch={updated_by:user.id};
    if(!p.nome&&name)patch.nome=name;if(!p.descricao&&name)patch.descricao=name;if(!p.categoria&&cat)patch.categoria=cat;
    if(!p.marca&&brand)patch.marca=brand;if(p.peso_kg==null&&kg!=null)patch.peso_kg=kg;if(!p.medidas&&medidas)patch.medidas=medidas;
    const ur=await fetch(`${S}/rest/v1/products?id=eq.${p.id}`,{method:"PATCH",headers:{...H(secret,token),"content-type":"application/json"},body:JSON.stringify(patch)});
    if(!ur.ok){errors++;continue}updated++;
   }
   const img=val(r,"Imagem principal");if(img){
    const er=await fetch(`${S}/rest/v1/product_images?product_id=eq.${p.id}&select=id&limit=1`,{headers:H(secret,token)}),ei=await er.json();
    if(!ei?.length){
     try{
      const im=await fetch(img,{headers:{"user-agent":"Mozilla/5.0 ProelisCatalogImport/1.0"},signal:AbortSignal.timeout(7000)});
      if(im.ok){
       const bytes=await im.arrayBuffer(),ct=im.headers.get("content-type")||"image/jpeg",ext=ct.includes("png")?"png":ct.includes("webp")?"webp":"jpg",path=`site/${ref}/${Date.now()}.${ext}`;
       const up=await fetch(`${S}/storage/v1/object/product-images/${path}`,{method:"POST",headers:{apikey:secret,"content-type":ct,"x-upsert":"false"},body:bytes});
       if(up.ok){
        const pi=await fetch(`${S}/rest/v1/product_images`,{method:"POST",headers:{...H(secret,token),"content-type":"application/json"},body:JSON.stringify({product_id:p.id,storage_path:path,origem:"site_proelis",url_origem:img,principal:true,created_by:user.id})});
        if(pi.ok)photos++;
       }
      }
     }catch{}
    }
   }
  }
  return json(200,{ok:true,total:rows.length,created,updated,skipped,photos,errors});
 }catch(e){return json(500,{error:e?.message||String(e)})}
};
