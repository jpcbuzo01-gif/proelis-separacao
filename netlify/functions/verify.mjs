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
    const focus1=fd.get("focus1");
    const focus2=fd.get("focus2");
    const detail1=fd.get("detail1");
    const detail2=fd.get("detail2");
    let visualCalibration=null;
    let geometricBoreMeasurement=null;
    const geometricBoreRaw=fd.get("geometric_bore_measurement");
    try{geometricBoreMeasurement=geometricBoreRaw?JSON.parse(String(geometricBoreRaw)):null}catch{}
    const visualCalibrationRaw=fd.get("visual_calibration");
    try{visualCalibration=visualCalibrationRaw?JSON.parse(String(visualCalibrationRaw)) : null}catch{}
    const calibrationMmPerPixel=Number(visualCalibration?.mmPerPixel)||0;
    const calibrationVideoWidth=Number(visualCalibration?.videoWidth)||0;
    const calibratedWidthMm=(calibrationMmPerPixel>0&&calibrationVideoWidth>0)?calibrationMmPerPixel*calibrationVideoWidth:null;
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
    const variantText=`${expected.description} ${expected.model}`.toLowerCase();
    const expectedBoreMm=/\b56\b/.test(variantText)?18:/\b48\b/.test(variantText)?16:null;
    const referenceImage=await getReferenceImage(expected.ref);
    const b64=Buffer.from(await photo.arrayBuffer()).toString("base64");
    const mime=photo.type || "image/jpeg";
    const asDataUrl=async f=>f&&typeof f.arrayBuffer==="function"?`data:${f.type||"image/jpeg"};base64,${Buffer.from(await f.arrayBuffer()).toString("base64")}`:null;
    const focusUrls=expectedBoreMm?{focus1:await asDataUrl(focus1),focus2:await asDataUrl(focus2),detail1:await asDataUrl(detail1),detail2:await asDataUrl(detail2)}:{};
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
Calibração da câmera fixa: ${calibratedWidthMm?`ATIVA — largura total da imagem corresponde aproximadamente a ${calibratedWidthMm.toFixed(3)} mm no plano calibrado`:"não disponível"}
Medida decisiva do FURO CENTRAL nesta família: ${expectedBoreMm?`${expectedBoreMm} mm (variante ${expectedBoreMm===18?"56":"48"})`:"não cadastrada/inferida"}

REGRA ESPECIAL 48/56 — VISÃO DUPLA (SOMENTE ESTA FAMÍLIA):
- Esta regra especial NÃO se aplica a rolamentos nem aos demais produtos. Preserve a análise normal de marcações/códigos para eles.
- Para 48/56, use a FOTO COMPLETA para confirmar PRIMEIRO que cada unidade pertence ao centrífugo/platinado correto: formato, molas, contatos, chapas, terminais, furos e construção geral.
- Depois use os RECORTES INDIVIDUAIS e os DETALHES CENTRAIS fornecidos para classificar a variante.
- NÃO faça medição em milímetros e NÃO dependa de régua, gabarito ou calibração.
- A diferença operacional é VISUAL: variante 48 = FURO CENTRAL MENOR; variante 56 = FURO CENTRAL MAIOR.
- Julgue CADA unidade separadamente pela proporção da abertura interna central em relação ao corpo/estrutura DA MESMA UNIDADE.
- Não compare apenas uma peça com a outra. Duas peças iguais também precisam ser classificadas individualmente.
- A classificação do furo NUNCA substitui a confirmação do produto completo. Se a geometria geral não confirmar o centrífugo esperado, REPROVADO/INCONCLUSIVO conforme a evidência.
- Observe SOMENTE a abertura interna escura do furo central. Ignore o aro/ressalto externo, molas, chapas metálicas e o diâmetro externo da peça.
- A câmera superior fixa é a vista correta. Não peça foto lateral, ângulo oblíquo ou medição do eixo.
- Use a FOTO OFICIAL como referência visual quando disponível, principalmente a proporção furo/corpo.
- Para cada unidade devolva bore_size_classifications com unit e size_class = "MENOR", "MAIOR" ou "INCONCLUSIVO".
- confidence deve ser "ALTA", "MEDIA" ou "BAIXA". Só use ALTA quando a abertura interna estiver inteira, nítida e a diferença de proporção estiver clara.
- Se duas unidades estiverem na foto, classifique as DUAS independentemente. Não use apenas "elas são iguais" como prova da variante.
- Pedido variante 48: todas as unidades precisam ser MENOR com confiança ALTA para aprovação visual desta característica.
- Pedido variante 56: todas as unidades precisam ser MAIOR com confiança ALTA para aprovação visual desta característica.
- MAIOR+MENOR em qualquer ordem = lote misto e deve ser REPROVADO.
- Se alguma unidade for INCONCLUSIVO ou confiança diferente de ALTA = INCONCLUSIVO, nunca aprove por palpite.
- NÃO invente 16 mm/18 mm. A tarefa é apenas MAIOR versus MENOR.

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
- ATENÇÃO A VARIANTES QUASE IDÊNTICAS: não trate “parecido com a foto” como suficiente quando pequenas dimensões físicas diferenciam modelos. Procure explicitamente diferenças no furo central, diâmetro do furo central, diâmetro, distância entre contatos, posição/altura de terminais, abas, furos, encaixes e proporções.
- Para centrífugos/platinados 48/56, use a classificação visual especial acima: 48 = abertura central MENOR; 56 = abertura central MAIOR. Não estime milímetros.
- IMPORTANTE SOBRE O ÂNGULO: para 48/56, a vista superior fixa é a vista normal. A abertura central deve estar inteira e visível.
- Se o furo central estiver escondido, inclinado demais, desfocado ou cortado, responda INCONCLUSIVO.
- Se houver mais de uma unidade, mantenha todas deitadas, lado a lado, mesma orientação, furos centrais totalmente visíveis e sem sobreposição.
- Nunca invente medida em milímetros para 48/56; classifique visualmente apenas MENOR/MAIOR/INCONCLUSIVO.
- Se a geometria e os detalhes físicos DISCRIMINANTES coincidirem claramente com a FOTO OFICIAL, a quantidade estiver correta e NÃO houver contradição visível, essa correspondência visual pode ser EVIDÊNCIA POSITIVA suficiente para APROVAR.
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
- Peça sem qualquer marca/modelo impresso, mas geometria, furos, encaixes e detalhes estruturais DISCRIMINANTES coincidem claramente com a foto oficial, sem contradições => APROVADO; identified_brand e identified_model podem ser null.
- Centrífugo/platinado 56 x 48: se a variante depende do furo central maior/menor, compare o diâmetro interno do furo central. Se isso não estiver claramente visível => INCONCLUSIVO, nunca aprove só pelo formato geral.
- Centrífugo/platinado com furo central oculto, cortado ou fora do plano calibrado => INCONCLUSIVO. Com câmera fixa calibrada, peça deitada + furo central totalmente visível é a posição preferida.
- Peça sem marcação e foto oficial insuficiente para excluir uma variante visualmente semelhante => INCONCLUSIVO.

REGRA ESPECIAL DE EQUIVALÊNCIA JÁ CADASTRADA:
- Rolamentos HCH: "2RS" é equivalente a "DDU".
- "ZZ" NÃO é equivalente a DDU/2RS.

Antes de escolher APROVADO, faça internamente esta checagem:
A) Quais atributos visíveis realmente DIFERENCIAM este produto de variantes parecidas? Para peças sem marcação, examine especialmente eixo, diâmetro interno do furo central, furos, encaixes e proporções.
B) Existe alguma contradição com o cadastro ou com a foto oficial?
C) A evidência visível confirma uma característica decisiva do cadastro ou, para produto sem marcação, a geometria/detalhes estruturais coincidem claramente com a foto oficial?
D) A marca/modelo realmente existe impresso na peça? Se não existir, não exija sua leitura.
Se uma característica decisiva estiver claramente confirmada, OU a peça sem marcação tiver correspondência estrutural clara com a foto oficial, e não houver contradições, APROVADO é permitido.
EXCEÇÃO CRÍTICA: nas variantes 48/56 deste centrífugo/platinado, semelhança geral NUNCA basta para APROVAR. A aprovação final exige DUAS evidências: (1) produto completo compatível e (2) classificação individual do furo MENOR/MAIOR com confiança ALTA usando os recortes da Visão Dupla.
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
 "bore_size_classifications":[{"unit":number,"size_class":"MENOR|MAIOR|INCONCLUSIVO","confidence":"ALTA|MEDIA|BAIXA","evidence":string}],
 "reason":string
}`;
    const body={
      model:MODEL,
      input:[{role:"user",content:[
        {type:"input_text",text:prompt+"\n\nIMAGEM 1: FOTO DO SEPARADOR (imagem a ser julgada)."},
        {type:"input_image",image_url:`data:${mime};base64,${b64}`,detail:"high"},
        ...(expectedBoreMm&&focusUrls.focus1?[{type:"input_text",text:"IMAGEM 1A: RECORTE DA PEÇA 1. Use para conferir a peça individualmente."},{type:"input_image",image_url:focusUrls.focus1,detail:"high"}]:[]),
        ...(expectedBoreMm&&focusUrls.detail1?[{type:"input_text",text:"IMAGEM 1B: ZOOM CENTRAL DA PEÇA 1. Use SOMENTE como detalhe adicional do furo; a foto completa continua obrigatória."},{type:"input_image",image_url:focusUrls.detail1,detail:"high"}]:[]),
        ...(expectedBoreMm&&focusUrls.focus2?[{type:"input_text",text:"IMAGEM 1C: RECORTE DA PEÇA 2. Use para conferir a peça individualmente."},{type:"input_image",image_url:focusUrls.focus2,detail:"high"}]:[]),
        ...(expectedBoreMm&&focusUrls.detail2?[{type:"input_text",text:"IMAGEM 1D: ZOOM CENTRAL DA PEÇA 2. Use SOMENTE como detalhe adicional do furo; a foto completa continua obrigatória."},{type:"input_image",image_url:focusUrls.detail2,detail:"high"}]:[]),
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
    d.calibration_received=!!(calibrationMmPerPixel>0&&calibrationVideoWidth>0);
    d.calibration_mm_per_pixel=calibrationMmPerPixel||null;
    d.calibration_video_width=calibrationVideoWidth||null;
    d.calibrated_image_width_mm=calibratedWidthMm?Number(calibratedWidthMm.toFixed(2)):null;
    d.identified_brand=d.identified_brand==null?null:norm(d.identified_brand);
    d.identified_model=d.identified_model==null?null:norm(d.identified_model);
    d.identified_quantity=Number.isFinite(Number(d.identified_quantity))?Number(d.identified_quantity):null;
    d.decisive_attribute_seen=d.decisive_attribute_seen==null?null:norm(d.decisive_attribute_seen);
    if(!Array.isArray(d.visible_markings)) d.visible_markings=d.visible_markings?[norm(d.visible_markings)]:[];
    if(!Array.isArray(d.positive_evidence)) d.positive_evidence=[];
    if(!Array.isArray(d.contradictions)) d.contradictions=[];
    if(!Array.isArray(d.variant_exclusion_evidence)) d.variant_exclusion_evidence=[];
    if(!Array.isArray(d.bore_size_classifications)) d.bore_size_classifications=[];
    d.bore_size_classifications=d.bore_size_classifications.map((x,idx)=>({unit:Number(x?.unit)||idx+1,size_class:upper(x?.size_class),confidence:upper(x?.confidence),evidence:norm(x?.evidence)}));

    // V10.42 — Visão Dupla exclusiva 48/56: foto completa + recortes individuais + zoom central.
    d.visual_bore_classification_used=false;
    d.dual_vision_4856_used=!!(expectedBoreMm&&(focusUrls.focus1||focusUrls.detail1));
    if(expectedBoreMm){
      const expectedVariant=expectedBoreMm===18?56:48;
      const expectedClass=expectedVariant===56?"MAIOR":"MENOR";
      const cls=d.bore_size_classifications.slice(0,expected.qty);
      d.expected_bore_class=expectedClass;
      d.visual_bore_classes=cls.map(x=>x.size_class);

      // A quantidade ainda precisa estar confirmada visualmente.
      if(d.identified_quantity!==expected.qty){
        d.status="INCONCLUSIVO";d.error_type="inconclusivo";
        d.measurement_failure="bore_visual_quantity_uncertain";
        d.reason=`A IA não confirmou com segurança as ${expected.qty} unidades do lote para classificar os furos individualmente.`;
      }else if(cls.length<expected.qty){
        d.status="INCONCLUSIVO";d.error_type="inconclusivo";
        d.measurement_failure="bore_visual_classification_missing";
        d.reason=`A IA classificou apenas ${cls.length} de ${expected.qty} furos centrais. É necessário classificar cada unidade como MAIOR ou MENOR.`;
      }else if(cls.some(x=>!['MAIOR','MENOR'].includes(x.size_class)||x.confidence!=="ALTA")){
        d.status="INCONCLUSIVO";d.error_type="inconclusivo";
        d.measurement_failure="bore_visual_classification_uncertain";
        d.reason=`Classificação visual sem confiança alta em todas as unidades: ${cls.map(x=>`unidade ${x.unit}: ${x.size_class||'INCONCLUSIVO'} (${x.confidence||'SEM CONFIANÇA'})`).join('; ')}.`;
      }else{
        d.visual_bore_classification_used=true;
        const wrong=cls.filter(x=>x.size_class!==expectedClass);
        const mixed=new Set(cls.map(x=>x.size_class)).size>1;
        d.mixed_variant_detected=mixed;
        if(wrong.length){
          d.status="REPROVADO";d.error_type="modelo";
          d.reason=`FURO CENTRAL incompatível. Pedido espera variante ${expectedVariant} = furo ${expectedClass}. ${cls.map(x=>`unidade ${x.unit}: ${x.size_class}`).join('; ')}.`;
          d.contradictions.push(...wrong.map(x=>`unidade ${x.unit}: furo ${x.size_class}; esperado ${expectedClass}`));
        }else if(!d.contradictions.length){
          d.status="APROVADO";d.error_type="nenhum";
          d.decisive_attribute_seen=`furo central ${expectedClass.toLowerCase()} em todas as ${expected.qty} unidades`;
          d.positive_evidence.push(...cls.map(x=>`unidade ${x.unit}: furo ${x.size_class.toLowerCase()} — ${x.evidence||'proporção visual compatível'}`));
          d.reason=`Todas as ${expected.qty} unidades foram classificadas com confiança ALTA como furo ${expectedClass}, compatível com a variante ${expectedVariant}.`;
        }
      }

      // Nunca devolver instruções antigas de medição/ângulo/gabarito para 48/56.
      const legacy=/gabarito|calibra|mil[ií]metr|mm\b|mude o [aâ]ngulo|de lado|obl[ií]qu|mostrar o eixo|medição geométrica/i.test(norm(d.reason));
      if(d.status==="INCONCLUSIVO"&&legacy){
        d.reason=`Não foi possível classificar visualmente todos os furos como ${expectedClass} com confiança alta. Mantenha a vista superior, com a abertura central inteira e nítida.`;
        d.measurement_failure="bore_visual_classification_uncertain";
      }
    }

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
    d.validation_policy="explicit_code_guard_v8_4_2+shaft_side_view_v10_33+visual_bore_size_classification_v10_41";

    return new Response(JSON.stringify(d),{status:200,headers:{"content-type":"application/json"}});
  }catch(e){
    return new Response(JSON.stringify({error:e.message||String(e)}),{status:500,headers:{"content-type":"application/json"}});
  }
};
