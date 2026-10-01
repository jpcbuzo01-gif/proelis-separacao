const MODEL = process.env.OPENAI_VISION_MODEL || "gpt-5.6-luna";
const S = process.env.SUPABASE_URL || "https://mbxmhojgoqzqfxzajafb.supabase.co";
const PUB = process.env.SUPABASE_PUBLISHABLE_KEY || "sb_publishable_6YxdvuPcirHBODEEylOUsQ_xsehFq_d";
const SECRET = process.env.SUPABASE_SECRET_KEY;
const env = name => process.env[name];

function norm(v){ return String(v ?? "").trim(); }
function upper(v){ return norm(v).toUpperCase(); }
function cleanErrorType(v){
  const x=norm(v).toLowerCase();
  const map={
    produto:"produto", product:"produto", produto_errado:"produto", wrong_product:"produto",
    modelo:"modelo", model:"modelo", codigo:"modelo", "código":"modelo", modelo_codigo:"modelo", wrong_model:"modelo",
    marca:"marca", brand:"marca", wrong_brand:"marca",
    quantidade:"quantidade", quantity:"quantidade", wrong_quantity:"quantidade",
    nenhum:"nenhum", none:"nenhum", inconclusivo:"inconclusivo", unclear:"inconclusivo"
  };
  return map[x] || "inconclusivo";
}
function extractJSON(text){
  try{return JSON.parse(text)}
  catch{
    const m=String(text||"").match(/\{[\s\S]*\}/);
    if(!m) throw new Error("Resposta da IA sem JSON válido.");
    return JSON.parse(m[0]);
  }
}


async function getReferenceImage(ref){
  if(!SECRET || !ref) return null;
  const h={apikey:SECRET,Authorization:`Bearer ${SECRET}`};
  const pr=await fetch(`${S}/rest/v1/products?referencia=eq.${encodeURIComponent(ref)}&select=id&limit=1`,{headers:h});
  if(!pr.ok) return null;
  const pa=await pr.json(),p=pa?.[0]; if(!p) return null;
  const ir=await fetch(`${S}/rest/v1/product_images?product_id=eq.${p.id}&select=storage_path,principal,ordem&order=principal.desc,ordem.asc&limit=1`,{headers:h});
  if(!ir.ok) return null;
  const ia=await ir.json(),pic=ia?.[0]; if(!pic?.storage_path) return null;
  const sr=await fetch(`${S}/storage/v1/object/sign/product-images/${pic.storage_path}`,{
    method:"POST",headers:{...h,"content-type":"application/json"},body:JSON.stringify({expiresIn:300})
  });
  if(!sr.ok) return null;
  const sd=await sr.json();
  const signed=sd.signedURL||sd.signedUrl;
  if(!signed) return null;
  return signed.startsWith("http")?signed:`${S}/storage/v1${signed}`;
}

export default async (req) => {
  if(req.method !== "POST") return new Response(JSON.stringify({error:"Método não permitido"}),{status:405,headers:{"content-type":"application/json"}});
  try{
    const key=env("OPENAI_API_KEY");
    if(!key) throw new Error("OPENAI_API_KEY não configurada.");
    const fd=await req.formData();
    const photo=fd.get("photo");
    const expected={
      ref:norm(fd.get("ref")), qty:Number(fd.get("qty")||0), description:norm(fd.get("description")),
      brand:norm(fd.get("brand")), model:norm(fd.get("model"))
    };
    if(!photo || typeof photo.arrayBuffer!=="function") throw new Error("Foto não recebida.");
    const referenceImage=await getReferenceImage(expected.ref);
    const b64=Buffer.from(await photo.arrayBuffer()).toString("base64");
    const mime=photo.type || "image/jpeg";
    const prompt=`Você é o conferente visual de expedição da Proelis.
Você receberá a FOTO DO SEPARADOR e, quando disponível, uma FOTO OFICIAL DE REFERÊNCIA do catálogo.
A foto oficial é evidência complementar: ajuda a reconhecer família, embalagem, formato e marcações, mas NÃO pode sozinha causar reprovação.
A decisão deve ser sustentada principalmente pelo que está visível na FOTO DO SEPARADOR.

ITEM ESPERADO:
Referência interna Proelis: ${expected.ref}
Descrição: ${expected.description}
Marca: ${expected.brand}
Modelo/código do produto: ${expected.model}
Quantidade deste lote: ${expected.qty}

REGRAS:
- APROVADO somente se produto, marca, modelo/código e quantidade estiverem confirmados visualmente.
- REPROVADO se houver evidência visual clara de incompatibilidade.
- INCONCLUSIVO se a foto não permitir confirmar com segurança. INCONCLUSIVO não é erro do operador.
- Para rolamentos HCH, "2RS" é equivalente a "DDU". Não reprove HCH apenas porque a embalagem mostra 2RS e a descrição esperada usa DDU.
- "ZZ" NÃO é equivalente a DDU/2RS.
- Não adivinhe marcações ilegíveis.
- A FOTO OFICIAL pode ter embalagem, ângulo, cor ou revisão visual diferente. Diferença estética isolada NÃO reprova.
- Se a foto oficial não estiver disponível, siga normalmente usando os dados textuais e a foto do separador.
- Se o item do separador não permitir confirmar marca/modelo/quantidade com segurança, use INCONCLUSIVO, não REPROVADO.
- Se houver reprovação, error_type deve indicar a causa PRINCIPAL:
  produto = produto/tipo diferente;
  modelo = modelo/código/referência técnica incompatível;
  marca = marca incompatível;
  quantidade = quantidade visivelmente diferente.
- Se aprovado: error_type="nenhum".
- Se inconclusivo: error_type="inconclusivo".
- Exemplo: esperado modelo 607 e identificado 6203 => REPROVADO e error_type="modelo", nunca "quantidade".

Responda APENAS JSON válido:
{
 "status":"APROVADO|REPROVADO|INCONCLUSIVO",
 "error_type":"nenhum|produto|modelo|marca|quantidade|inconclusivo",
 "identified_brand":string|null,
 "identified_model":string|null,
 "identified_quantity":number|null,
 "visible_markings":string[],
 "reason":string
}`;
    const body={
      model:MODEL,
      input:[{role:"user",content:[
        {type:"input_text",text:prompt+"\n\nIMAGEM 1: FOTO DO SEPARADOR (imagem a ser julgada)."},
        {type:"input_image",image_url:`data:${mime};base64,${b64}`,detail:"high"},
        ...(referenceImage?[
          {type:"input_text",text:"IMAGEM 2: FOTO OFICIAL DE REFERÊNCIA DO CATÁLOGO. Use apenas como evidência complementar; não reprove por diferença estética isolada."},
          {type:"input_image",image_url:referenceImage,detail:"high"}
        ]:[])
      ]}],
      max_output_tokens:700
    };
    const r=await fetch("https://api.openai.com/v1/responses",{method:"POST",headers:{
      "Authorization":`Bearer ${key}`,"Content-Type":"application/json"
    },body:JSON.stringify(body)});
    const raw=await r.text();
    if(!r.ok) return new Response(JSON.stringify({error:`OpenAI ${r.status}: ${raw.slice(0,500)}`}),{status:r.status,headers:{"content-type":"application/json"}});
    const api=JSON.parse(raw);
    const text=api.output_text || (api.output||[]).flatMap(o=>o.content||[]).map(c=>c.text||"").join("");
    const d=extractJSON(text);
    d.status=upper(d.status);
    d.error_type=cleanErrorType(d.error_type);
    d.identified_brand=d.identified_brand==null?null:norm(d.identified_brand);
    d.identified_model=d.identified_model==null?null:norm(d.identified_model);
    d.identified_quantity=Number.isFinite(Number(d.identified_quantity))?Number(d.identified_quantity):null;
    if(!Array.isArray(d.visible_markings)) d.visible_markings=d.visible_markings?[norm(d.visible_markings)]:[];

    // Deterministic consistency guard: model mismatch always classifies as modelo.
    if(d.status==="REPROVADO" && expected.model && d.identified_model &&
       upper(expected.model)!==upper(d.identified_model)){
      d.error_type="modelo";
    } else if(d.status==="REPROVADO" && expected.brand && d.identified_brand &&
       upper(expected.brand)!==upper(d.identified_brand)){
      d.error_type="marca";
    } else if(d.status==="REPROVADO" && d.identified_quantity!==null &&
       expected.qty>0 && d.identified_quantity!==expected.qty &&
       !["modelo","marca","produto"].includes(d.error_type)){
      d.error_type="quantidade";
    }
    if(d.status==="APROVADO") d.error_type="nenhum";
    if(d.status==="INCONCLUSIVO") d.error_type="inconclusivo";
    d.reference_image_used=Boolean(referenceImage);

    return new Response(JSON.stringify(d),{status:200,headers:{"content-type":"application/json"}});
  }catch(e){
    return new Response(JSON.stringify({error:e.message||String(e)}),{status:500,headers:{"content-type":"application/json"}});
  }
};
