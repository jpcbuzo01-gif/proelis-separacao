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



function techTokens(v){
  return upper(v).replace(/[^A-Z0-9]+/g," ").split(/\s+/).filter(Boolean);
}
function primaryTechnicalId(v){
  const ignore=new Set(["2RS","DDU","ZZ","C3","C4","RS","Z"]);
  const toks=techTokens(v).filter(t=>!ignore.has(t));
  // Prefer a 4+ digit model number (6200/6201 etc), then alphanumeric code containing digits.
  return toks.find(t=>/^\d{4,}$/.test(t))
      || toks.find(t=>/[A-Z]/.test(t)&&/\d/.test(t)&&t.length>=3)
      || toks.find(t=>/^\d{3,}$/.test(t))
      || null;
}
function explicitTechnicalIds(values){
  const out=[];
  for(const value of values||[]){
    const toks=techTokens(value);
    for(const t of toks){
      if(/^\d{4,}$/.test(t) || (/[A-Z]/.test(t)&&/\d/.test(t)&&t.length>=3)) out.push(t);
    }
  }
  return [...new Set(out)];
}
function meaningful(v){
  const x=upper(v);
  return x && !["A CONFIRMAR","N/A","NA","SEM MODELO","NÃO INFORMADO","NAO INFORMADO","-"].includes(x);
}
async function getCatalogProduct(ref){
  if(!SECRET || !ref) return null;
  const h={apikey:SECRET,Authorization:`Bearer ${SECRET}`};
  const fields="id,referencia,nome,descricao,categoria,subcategoria,marca,fabricante,modelo,codigo_fabricante,peso_kg,medidas,especificacoes,observacoes_separacao";
  const r=await fetch(`${S}/rest/v1/products?referencia=eq.${encodeURIComponent(ref)}&select=${fields}&limit=1`,{headers:h});
  if(!r.ok) return null;
  const a=await r.json();
  return a?.[0]||null;
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
    const catalog=await getCatalogProduct(expected.ref);
    if(catalog){
      expected.description=norm(catalog.nome||catalog.descricao||expected.description);
      expected.brand=norm(catalog.marca||catalog.fabricante||expected.brand);
      expected.model=norm(catalog.modelo||catalog.codigo_fabricante||expected.model);
    }
    const referenceImage=await getReferenceImage(expected.ref);
    const b64=Buffer.from(await photo.arrayBuffer()).toString("base64");
    const mime=photo.type || "image/jpeg";
    const prompt=`Você é o sistema de conferência visual de expedição da Proelis.
Sua prioridade é EVITAR FALSO POSITIVO: nunca aprove um item apenas porque ele parece pertencer à mesma família do produto esperado.

Você receberá:
1) FOTO DO SEPARADOR — é a mercadoria que deve ser julgada.
2) Quando disponível, FOTO OFICIAL DO CATÁLOGO — somente referência complementar.
3) Dados oficiais do cadastro do produto.

PRODUTO ESPERADO:
Referência interna Proelis: ${expected.ref}
Nome/descrição: ${expected.description}
Marca: ${expected.brand}
Modelo/código: ${expected.model}
Quantidade do lote: ${expected.qty}
Categoria: ${norm(catalog?.categoria)}
Subcategoria: ${norm(catalog?.subcategoria)}
Fabricante: ${norm(catalog?.fabricante)}
Código fabricante: ${norm(catalog?.codigo_fabricante)}
Medidas: ${norm(catalog?.medidas)}
Especificações: ${JSON.stringify(catalog?.especificacoes||{})}
Observações de separação: ${norm(catalog?.observacoes_separacao)}

REGRA UNIVERSAL DE APROVAÇÃO:
- APROVADO exige EVIDÊNCIA POSITIVA suficiente de que a FOTO DO SEPARADOR corresponde ao produto esperado.
- Similaridade visual, mesma família, mesma cor, mesma embalagem ou peso compatível NÃO bastam sozinhos.
- Se houver modelo, código, tensão, capacitância, medida, bitola, espessura, dimensão, potência, vedação, variante, marcação ou outra característica técnica visível que diferencie variantes, use essa característica como evidência decisiva.
- Quando o cadastro tiver uma característica técnica decisiva (modelo/código/capacidade/medida etc.), procure essa característica primeiro.
- Se ela estiver claramente visível e compatível, isso é evidência forte para APROVAR, mesmo que outros textos secundários estejam pequenos ou parcialmente ilegíveis.
- Se a característica decisiva não estiver legível e existirem variantes visualmente indistinguíveis, responda INCONCLUSIVO. Nunca invente a variante.
- Se aparecer uma característica incompatível com o esperado, responda REPROVADO.
- MUITO IMPORTANTE: transcreva em visible_markings EXATAMENTE os códigos/modelos realmente legíveis na FOTO DO SEPARADOR. Não copie o modelo esperado para identified_model se ele não estiver legível na foto.
- Se a foto mostrar explicitamente um código técnico diferente do esperado (ex.: 6200 quando esperado 6201), isso domina qualquer semelhança visual/foto oficial e deve ser REPROVADO.
- A FOTO OFICIAL ajuda a localizar características e reconhecer o produto.
- PRODUTOS SEM MARCAÇÃO VISÍVEL: algumas peças (ex.: centrífugos, tampas, ventoinhas e componentes moldados) podem não trazer marca, modelo ou código impressos. Nesses casos, NÃO exija texto inexistente e NÃO responda INCONCLUSIVO apenas porque marca/modelo não estão legíveis.
- Quando a peça esperada não possui marcação física visível, compare diretamente FOTO DO SEPARADOR x FOTO OFICIAL usando características físicas discriminantes: formato, geometria, número/posição de furos, encaixes, nervuras, recortes, abas, diâmetros relativos, perfil, cor quando realmente distintiva e outros detalhes estruturais.
- Se a geometria e os detalhes físicos relevantes coincidirem claramente com a FOTO OFICIAL, a quantidade estiver correta e NÃO houver contradição visível, essa correspondência visual pode ser EVIDÊNCIA POSITIVA suficiente para APROVAR.
- Se existirem variantes cadastradas/visualmente possíveis que não possam ser distinguidas pela foto, continue INCONCLUSIVO; foto parecida não deve virar aprovação por adivinhação.
- Marca/modelo ausentes na própria peça devem retornar identified_brand/identified_model como null; ausência não é erro de marca/modelo.
- O código interno Proelis pode não estar impresso na mercadoria; não exija que ele esteja visível.
- Quantidade deve corresponder ao lote solicitado quando for possível contar com segurança.
- Não adivinhe texto, código ou quantidade escondida/ilegível.
- Peso é validado separadamente pelo sistema. Peso compatível nunca transforma identificação visual duvidosa em APROVADO.

EXEMPLOS DA REGRA (válidos para QUALQUER categoria):
- Esperado 6201 e foto mostra 6200 => REPROVADO/modelo.
- Esperado capacitor 30µF e foto mostra 25µF => REPROVADO/modelo.
- Esperado peça de uma variante específica, mas o código/medida que diferencia as variantes não pode ser lido => INCONCLUSIVO.
- Produto esperado e foto confirmam claramente os atributos técnicos relevantes => APROVADO.
- Peça sem qualquer marca/modelo impresso, mas geometria, furos, encaixes e detalhes estruturais coincidem claramente com a foto oficial, sem contradições => APROVADO; identified_brand e identified_model podem ser null.
- Peça sem marcação e foto oficial insuficiente para excluir uma variante visualmente semelhante => INCONCLUSIVO.

REGRA ESPECIAL DE EQUIVALÊNCIA JÁ CADASTRADA:
- Rolamentos HCH: "2RS" é equivalente a "DDU".
- "ZZ" NÃO é equivalente a DDU/2RS.

Antes de escolher APROVADO, faça internamente esta checagem:
A) Quais atributos visíveis identificam este produto?
B) Existe alguma contradição com o cadastro?
C) A evidência visível confirma uma característica decisiva do cadastro ou, para produto sem marcação, a geometria/detalhes estruturais coincidem claramente com a foto oficial?
D) A marca/modelo realmente existe impresso na peça? Se não existir, não exija sua leitura.
Se uma característica decisiva estiver claramente confirmada, OU a peça sem marcação tiver correspondência estrutural clara com a foto oficial, e não houver contradições, APROVADO é permitido.
Se não houver evidência suficiente para diferenciar variantes, INCONCLUSIVO.
Se houver característica incompatível, REPROVADO.

error_type na causa PRINCIPAL:
produto = tipo/família diferente
modelo = modelo/código/especificação/variante técnica incompatível
marca = marca incompatível
quantidade = quantidade incompatível
nenhum = aprovado
inconclusivo = evidência insuficiente

Responda APENAS JSON válido:
{
 "status":"APROVADO|REPROVADO|INCONCLUSIVO",
 "error_type":"nenhum|produto|modelo|marca|quantidade|inconclusivo",
 "identified_brand":string|null,
 "identified_model":string|null,
 "identified_quantity":number|null,
 "visible_markings":string[],
 "positive_evidence":string[],
 "contradictions":string[],
 "variant_exclusion_evidence":string[],
 "decisive_attribute_seen":string|null,
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
    d.decisive_attribute_seen=d.decisive_attribute_seen==null?null:norm(d.decisive_attribute_seen);
    if(!Array.isArray(d.visible_markings)) d.visible_markings=d.visible_markings?[norm(d.visible_markings)]:[];
    if(!Array.isArray(d.positive_evidence)) d.positive_evidence=[];
    if(!Array.isArray(d.contradictions)) d.contradictions=[];
    if(!Array.isArray(d.variant_exclusion_evidence)) d.variant_exclusion_evidence=[];

    // V8.4: trava universal contra falso positivo.
    // Uma contradição explícita jamais pode terminar como APROVADO.
    if(d.status==="APROVADO" && d.contradictions.length){
      d.status="REPROVADO";
      d.error_type="modelo";
      d.reason=`Contradição encontrada: ${d.contradictions.join("; ")}. ${norm(d.reason)}`.trim();
    }

    // Se existe modelo/código oficial significativo e a IA identificou outro, força reprovação,
    // inclusive quando o modelo tentou responder APROVADO.
    const expectedPrimary=primaryTechnicalId(expected.model)||primaryTechnicalId(expected.description);
    const seenIds=explicitTechnicalIds([d.identified_model,...d.visible_markings,d.decisive_attribute_seen,...d.positive_evidence,...d.contradictions]);
    const conflictingSeen=expectedPrimary?seenIds.find(x=>x!==expectedPrimary && /^\d{4,}$/.test(x) && /^\d{4,}$/.test(expectedPrimary)):null;

    // V8.4.2: código técnico EXPLICITAMENTE LIDO na foto vence a inferência da IA.
    // Ex.: esperado 6201 e visible_markings contém 6200 => REPROVADO, mesmo que identified_model diga 6201.
    if(conflictingSeen){
      d.status="REPROVADO";
      d.error_type="modelo";
      d.reason=`Código técnico visível (${conflictingSeen}) incompatível com o esperado (${expectedPrimary}). ${norm(d.reason)}`.trim();
      d.detected_conflicting_code=conflictingSeen;
    } else if(meaningful(expected.model) && meaningful(d.identified_model)){
      const identifiedPrimary=primaryTechnicalId(d.identified_model);
      if(expectedPrimary && identifiedPrimary && expectedPrimary!==identifiedPrimary){
        d.status="REPROVADO";
        d.error_type="modelo";
        d.reason=`Modelo/código identificado (${identifiedPrimary}) incompatível com o esperado (${expectedPrimary}). ${norm(d.reason)}`.trim();
        d.detected_conflicting_code=identifiedPrimary;
      }
    }

    // V10.31: produto sem marcação pode ser confirmado pela geometria comparada à foto oficial.
    // Continua proibido aprovar sem evidência positiva: a IA precisa declarar os detalhes físicos compatíveis.
    if(d.status==="APROVADO" && d.positive_evidence.length===0 && d.visible_markings.length===0){
      d.status="INCONCLUSIVO";
      d.error_type="inconclusivo";
      d.reason=`Não há evidência visual positiva suficiente para confirmar o produto. ${norm(d.reason)}`.trim();
    }

    // Deterministic consistency guard: model mismatch always classifies as modelo.
    if(d.status==="REPROVADO" && d.error_type==="modelo"){
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
    d.catalog_product_used=Boolean(catalog);
    d.validation_policy="explicit_code_guard_v8_4_2+unmarked_reference_match_v10_31";

    return new Response(JSON.stringify(d),{status:200,headers:{"content-type":"application/json"}});
  }catch(e){
    return new Response(JSON.stringify({error:e.message||String(e)}),{status:500,headers:{"content-type":"application/json"}});
  }
};
