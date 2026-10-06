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

REGRA ABSOLUTA DE POSICIONAMENTO 48/56:
- Com expectedBoreMm definido e calibração ativa, a VISTA SUPERIOR da câmera fixa é o ângulo CORRETO.
- PROIBIDO pedir para virar a peça, mostrar de lado, usar ângulo oblíquo ou mostrar comprimento/projeção de eixo.
- Se os furos centrais estão inteiros na foto, NÃO use ângulo como motivo de INCONCLUSIVO.
- Ignore qualquer regra geral sobre eixo lateral que conflite com esta regra.
- A tarefa dimensional é somente localizar as bordas INTERNAS esquerda/direita do furo central.

MEDIÇÃO VISUAL CALIBRADA DO FURO CENTRAL:
- Quando a calibração estiver ATIVA e a medida decisiva do eixo estiver informada, localize a BORDA ESQUERDA e a BORDA DIREITA do círculo interno do FURO CENTRAL de CADA unidade na FOTO DO SEPARADOR.
- A peça deve estar deitada/plana, vista de cima, no mesmo plano calibrado da balança, com o furo central totalmente visível.
- Para cada furo central claramente visível, devolva bore_measurements com x_left e x_right em coordenadas horizontais normalizadas de 0 a 1000, onde 0 é a borda esquerda da FOTO DO SEPARADOR e 1000 a borda direita.
- NÃO estime milímetros por conta própria. Apenas localize os pontos x_base/x_tip; o servidor fará a conversão determinística usando a calibração.
- Se o furo central estiver visível como na vista superior da estação, SEMPRE forneça x_left e x_right para cada unidade. Não devolva usable:false apenas por perspectiva/ângulo leve.
- usable:false somente se uma das bordas internas estiver realmente oculta, cortada para fora da imagem ou impossível de localizar.
- Duas unidades exigem duas medições. Meça o DIÂMETRO INTERNO do furo, não o diâmetro externo do ressalto/corpo.
- A vista de cima da câmera fixa é a posição NORMAL e PREFERIDA. Não peça foto lateral/oblíqua para esta medição.
- A tarefa aqui não é estimar milímetros: apenas marcar as bordas internas esquerda/direita. O servidor calcula os milímetros.

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
- Para centrífugos e platinados, dê atenção especial ao DIÂMETRO INTERNO DO FURO CENTRAL e às proporções físicas. Exemplo operacional informado pela Proelis: variantes 56 e 48 podem ser visualmente muito semelhantes e o furo para eixo da 56 é de 18 mm e o da 48 é de 16 mm. Não aprove uma delas sem evidência visual suficiente dessa diferença quando ela for necessária para distinguir a variante.
- IMPORTANTE SOBRE O ÂNGULO: sem calibração, use apenas comparação relativa. COM calibração ativa, uma vista superior é válida se a peça estiver DEITADA, o eixo estiver aproximadamente HORIZONTAL no plano da balança e as duas bordas do furo central estiverem totalmente visíveis.
- Se o furo central estiver escondido, inclinado demais, desfocado ou cortado, responda INCONCLUSIVO.
- Se houver mais de uma unidade, mantenha todas deitadas, lado a lado, mesma orientação, furos centrais totalmente visíveis e sem sobreposição.
- Nunca invente medida em milímetros: quando houver calibração, forneça somente as coordenadas normalizadas pedidas e deixe o servidor calcular.
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
EXCEÇÃO CRÍTICA: nas variantes dimensionais 48/56 deste centrífugo/platinado, semelhança visual NUNCA basta para APROVAR. A aprovação final depende obrigatoriamente da medição calibrada do furo central feita pelo servidor.
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
 "bore_measurements":[{"unit":number,"x_left":number|null,"x_right":number|null,"usable":boolean}],
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
    if(!Array.isArray(d.bore_measurements)) d.bore_measurements=[];

    // V10.39 — medição geométrica local tem prioridade absoluta sobre coordenadas estimadas pela IA.
    d.geometric_measurement_received=!!(geometricBoreMeasurement?.ok);
    if(expectedBoreMm && geometricBoreMeasurement?.ok && Array.isArray(geometricBoreMeasurement.measurements)){
      const vals=geometricBoreMeasurement.measurements.slice(0,expected.qty).map(m=>Number(m.mm)).filter(Number.isFinite);
      if(vals.length>=expected.qty){
        d.bore_measurements=[]; // impede uso das coordenadas estimadas pela IA.
        d.geometric_bore_mm=vals.map(x=>Number(x.toFixed(2)));
      }
    }

    // V10.35: medição dimensional determinística pela câmera fixa calibrada.
    // A IA localiza apenas as bordas internas esquerda/direita em coordenadas 0..1000; o servidor converte para mm.
    d.visual_calibration_used=false;
    d.measured_bore_mm=[];
    if(calibratedWidthMm && expectedBoreMm){
      const usable=(expectedBoreMm
        ? (Array.isArray(d.geometric_bore_mm)?d.geometric_bore_mm:[])
        : d.bore_measurements.filter(m=>m&&m.usable===true&&Number.isFinite(Number(m.x_left))&&Number.isFinite(Number(m.x_right)))
          .map(m=>Math.abs(Number(m.x_right)-Number(m.x_left))/1000*calibratedWidthMm))
        .map(Number).filter(mm=>expectedBoreMm?(mm>=12&&mm<=22):(mm>5&&mm<40));
      d.measured_bore_mm=usable.map(mm=>Number(mm.toFixed(2)));
      if(usable.length>=Math.max(1,expected.qty)){
        const expectedVariant=expectedBoreMm===18?56:48;
        const classify=mm=>mm<=16.6?48:mm>=17.4?56:null;
        const variants=usable.map(classify);
        d.visual_calibration_used=true;
        d.measured_bore_median_mm=Number(([...usable].sort((a,b)=>a-b)[Math.floor(usable.length/2)]).toFixed(2));
        d.measured_bore_spread_mm=Number((Math.max(...usable)-Math.min(...usable)).toFixed(2));
        d.measured_variants=variants;
        d.measured_variant=variants.every(x=>x===variants[0])?variants[0]:null;

        // REGRA CRÍTICA: cada unidade é julgada separadamente.
        // Um lote 56+48 jamais pode ser aprovado pela média/mediana.
        if(variants.some(x=>x===null)){
          d.status="INCONCLUSIVO";d.error_type="inconclusivo";
          d.reason=`Medição individual entrou na zona de dúvida: ${d.measured_bore_mm.join(" / ")} mm. Nenhum lote misto ou duvidoso pode ser aprovado.`;
          d.measurement_failure="individual_dimension_uncertain";
        }else if(variants.some(x=>x!==expectedVariant)){
          d.status="REPROVADO";d.error_type="modelo";
          const wrong=usable.map((mm,idx)=>({mm,variant:variants[idx],unit:idx+1})).filter(x=>x.variant!==expectedVariant);
          d.reason=`Lote contém variante incorreta. Pedido espera ${expectedVariant} (${expectedBoreMm} mm), mas ${wrong.map(x=>`unidade ${x.unit}: ${x.mm.toFixed(1)} mm = variante ${x.variant}`).join("; ")}.`;
          d.contradictions.push(...wrong.map(x=>`unidade ${x.unit}: ${x.mm.toFixed(1)} mm / variante ${x.variant}`));
          d.mixed_variant_detected=variants.some(x=>x!==variants[0]);
        }else if(d.identified_quantity===expected.qty && !d.contradictions.length){
          d.status="APROVADO";d.error_type="nenhum";
          d.decisive_attribute_seen=`furos centrais medidos individualmente: ${d.measured_bore_mm.join(" / ")} mm`;
          d.positive_evidence.push(`todas as ${expected.qty} unidades medidas como variante ${expectedVariant}`);
          d.reason=`Todas as unidades foram medidas individualmente e correspondem à variante ${expectedVariant}: ${d.measured_bore_mm.join(" / ")} mm.`;
        }else{
          d.status="INCONCLUSIVO";d.error_type="inconclusivo";
          d.reason=`As medidas dimensionais são compatíveis, mas a quantidade visual não foi confirmada com segurança (${d.identified_quantity??"não identificada"} / esperado ${expected.qty}).`;
        }
      }else{
        d.status="INCONCLUSIVO";d.error_type="inconclusivo";
        d.reason=`Calibração ativa e vista superior aceita, porém a análise não marcou as duas bordas internas do furo central em todas as ${expected.qty} unidades. Mantenha as peças planas como estão, com os furos centrais livres e sem objetos sobre eles; não é necessário mudar o ângulo da câmera.`;
        d.measurement_failure="bore_edges_not_returned";
      }
    }

    // V10.39.4 — se detector geométrico falhar, preservar diagnóstico específico.
    if(expectedBoreMm && !d.geometric_measurement_received){
      d.status="INCONCLUSIVO";d.error_type="inconclusivo";d.measurement_failure="geometric_bore_required";
      d.reason="O gabarito V10.40 não produziu todas as medidas internas válidas. Mantenha os 4 marcadores pretos visíveis e as peças nas posições PEÇA 1 e PEÇA 2.";
    }

    // V10.39.2 — câmera superior fixa para 48/56; nunca devolver orientação lateral legada.
    if(expectedBoreMm){
      const legacy=/mude o [aâ]ngulo|[aâ]ngulo da foto|de lado|obl[ií]qu|mostrar o eixo|comprimento do eixo|proje[cç][aã]o do eixo/i.test(norm(d.reason));
      if(legacy){
        d.status="INCONCLUSIVO";d.error_type="inconclusivo";
        d.measurement_failure=d.geometric_measurement_received?"geometric_dimension_review":"geometric_bore_required";
        d.reason=d.geometric_measurement_received
          ?`Vista superior correta. Medição geométrica: ${(d.geometric_bore_mm||[]).join(" / ")} mm. Não mude o ângulo.`
          :"Vista superior correta. O detector geométrico não localizou todos os furos. Não mude o ângulo.";
      }
    }

    // V10.39 — para 48/56, NÃO permitir aprovação baseada em coordenadas da IA.
    // A dimensão crítica precisa vir do detector geométrico local.
    if(expectedBoreMm && d.status==="APROVADO" && !d.geometric_measurement_received){
      d.status="INCONCLUSIVO";d.error_type="inconclusivo";
      d.measurement_failure="geometric_bore_required";
      d.reason="A medição geométrica determinística do furo central não foi obtida. Para 48/56, a IA sozinha não pode aprovar.";
    }

    // V10.37.2 — saneia qualquer orientação lateral legada.
    if(expectedBoreMm && calibratedWidthMm){
      const legacyAngle=/ângulo|angulo|lateral|obl[ií]qu|virar|vire|de lado|comprimento do eixo|proje[cç][aã]o do eixo/i.test(norm(d.reason));
      if(d.status==="INCONCLUSIVO" && legacyAngle){
        d.measurement_failure="bore_edges_not_returned";
        d.reason=`Vista superior calibrada aceita. A leitura não marcou as bordas internas do furo central de todas as ${expected.qty} unidades. Mantenha as peças planas como estão; não mude o ângulo.`;
      }
    }

    // V10.37.1 — TRAVA DIMENSIONAL CRÍTICA.
    // Para variantes 48/56, APROVADO só pode existir após medição calibrada válida.
    // Nunca aceitar apenas semelhança visual/foto oficial quando a diferença decisiva é 16 x 18 mm.
    if(expectedBoreMm && d.status==="APROVADO" && !d.visual_calibration_used){
      d.status="INCONCLUSIVO";
      d.error_type="inconclusivo";
      d.measurement_failure=d.measurement_failure||"calibrated_dimension_required";
      d.reason=`A variante ${expectedBoreMm===18?"56":"48"} exige confirmação dimensional calibrada do furo central (${expectedBoreMm} mm). A semelhança visual não é suficiente para aprovar.`;
    }
    if(expectedBoreMm && d.status==="APROVADO" && d.visual_calibration_used && !Number.isFinite(Number(d.measured_variant))){
      d.status="INCONCLUSIVO";
      d.error_type="inconclusivo";
      d.measurement_failure="calibrated_dimension_required";
      d.reason="A medição calibrada não classificou com segurança a variante 48/56. Não aprovar.";
    }

    // V10.38 — segunda trava independente contra lote misto.
    if(expectedBoreMm && Array.isArray(d.measured_variants) && d.measured_variants.length){
      const expectedVariant=expectedBoreMm===18?56:48;
      if(d.measured_variants.some(x=>x!==null && x!==expectedVariant)){
        d.status="REPROVADO";d.error_type="modelo";d.mixed_variant_detected=true;
        d.reason=`TRAVA DIMENSIONAL: pelo menos uma unidade não corresponde à variante ${expectedVariant}. Medidas: ${(d.measured_bore_mm||[]).join(" / ")} mm.`;
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
    d.validation_policy="explicit_code_guard_v8_4_2+shaft_side_view_v10_33+jig_roi_measurement_v10_40";

    return new Response(JSON.stringify(d),{status:200,headers:{"content-type":"application/json"}});
  }catch(e){
    return new Response(JSON.stringify({error:e.message||String(e)}),{status:500,headers:{"content-type":"application/json"}});
  }
};
