const S=process.env.SUPABASE_URL||"https://mbxmhojgoqzqfxzajafb.supabase.co";
const json=(s,b)=>new Response(JSON.stringify(b),{status:s,headers:{"content-type":"application/json; charset=utf-8"}});
const H=(secret,token)=>({apikey:secret,Authorization:`Bearer ${token}`});
const clean=s=>(s??"").toString().trim();
const key=s=>clean(s).normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/[^a-z0-9]/gi,"").toLowerCase();
const val=(row,...names)=>{const map={};for(const [k,v] of Object.entries(row))map[key(k)]=v;for(const n of names){const v=map[key(n)];if(v!==undefined)return clean(v)}return""};
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
  const body=await req.json(),rows=Array.isArray(body.rows)?body.rows:[];
  if(!rows.length)return json(400,{error:"Lote vazio."});
  let created=0,updated=0,skipped=0,errors=0;const error_examples=[];
  for(const r of rows){
   const ref=clean(r.referencia);if(!ref){skipped++;continue}
   const name=clean(r.nome)||`Produto REF. ${ref}`,brand=clean(r.marca),cat=clean(r.categoria),medidas=clean(r.medidas),img=clean(r.imagem);
   const kg=(r.peso_kg===null||r.peso_kg===""||!Number.isFinite(Number(r.peso_kg)))?null:Number(r.peso_kg);
   try{
    const qr=await fetch(`${S}/rest/v1/products?referencia=eq.${encodeURIComponent(ref)}&select=*`,{headers:H(secret,token)}),arr=await qr.json();let p=arr?.[0];
    if(!p){
     const data={referencia:ref,nome:name,descricao:name,categoria:cat||null,marca:brand||null,peso_kg:kg,medidas:medidas||null,origem:"misto",created_by:user.id,updated_by:user.id};
     if(img)data.especificacoes={csv_image_url:img};
     const ir=await fetch(`${S}/rest/v1/products`,{method:"POST",headers:{...H(secret,token),"content-type":"application/json","prefer":"return=representation"},body:JSON.stringify(data)});
     if(!ir.ok)throw new Error(`INSERT ${ir.status}: ${(await ir.text()).slice(0,160)}`);created++;
    }else{
     const patch={updated_by:user.id},spec={...(p.especificacoes||{})};
     if(!p.nome&&name)patch.nome=name;if(!p.descricao&&name)patch.descricao=name;if(!p.categoria&&cat)patch.categoria=cat;
     if(!p.marca&&brand)patch.marca=brand;if(p.peso_kg==null&&kg!=null)patch.peso_kg=kg;if(!p.medidas&&medidas)patch.medidas=medidas;
     if(img&&!spec.csv_image_url){spec.csv_image_url=img;patch.especificacoes=spec}
     const ur=await fetch(`${S}/rest/v1/products?id=eq.${p.id}`,{method:"PATCH",headers:{...H(secret,token),"content-type":"application/json"},body:JSON.stringify(patch)});
     if(!ur.ok)throw new Error(`UPDATE ${ur.status}: ${(await ur.text()).slice(0,160)}`);updated++;
    }
   }catch(e){errors++;if(error_examples.length<5)error_examples.push(`REF. ${ref}: ${e.message||e}`)}
  }
  return json(200,{ok:true,total:rows.length,created,updated,skipped,errors,error_examples});
 }catch(e){return json(500,{error:e?.message||String(e)})}
};
