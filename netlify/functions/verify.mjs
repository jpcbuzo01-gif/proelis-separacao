const CATALOG={
"485":{ref:"485",description:"Rolamento HCH 6201 2RS DDU C3",brand:"HCH",model:"6201",seal:"DDU"},
"486":{ref:"486",description:"Rolamento HCH 6202 2RS DDU C3",brand:"HCH",model:"6202",seal:"DDU"}
};
const json=(o,s=200)=>new Response(JSON.stringify(o),{status:s,headers:{"content-type":"application/json; charset=utf-8"}});
export default async(req)=>{
 if(req.method!=="POST")return json({error:"Método não permitido"},405);
 try{
  const key=Netlify.env.get("OPENAI_API_KEY");if(!key)return json({error:"OPENAI_API_KEY não configurada no Netlify."},500);
  const form=await req.formData(),ref=String(form.get("ref")||""),qty=Number(form.get("qty")),photo=form.get("photo");
  const supplied={description:String(form.get("description")||""),brand:String(form.get("brand")||""),model:String(form.get("model")||"")};
  const base=CATALOG[ref]||{};const exp={ref,description:supplied.description||base.description||"",brand:supplied.brand||base.brand||"",model:supplied.model||base.model||"",seal:base.seal||(supplied.description.toUpperCase().includes("2RS")?"DDU":supplied.description.toUpperCase().includes("ZZ")?"ZZ":"")};
  if(!ref||!qty||!photo||typeof photo.arrayBuffer!=="function")return json({error:"Referência, quantidade ou foto ausente."},400);
  const bytes=new Uint8Array(await photo.arrayBuffer());if(bytes.byteLength>4_000_000)return json({error:"Foto ainda está grande demais após compressão."},413);
  let binary="";for(let n=0;n<bytes.length;n+=0x8000)binary+=String.fromCharCode(...bytes.subarray(n,n+0x8000));
  const dataUrl="data:image/jpeg;base64,"+btoa(binary);
  const instruction=`Conferência de estoque Proelis. Use somente evidência visual.
Esperado: referência ${exp.ref}; descrição ${exp.description}; marca ${exp.brand}; modelo ${exp.model}; quantidade ${qty}.
Regra HCH: em rolamentos HCH, "2RS" é equivalente à vedação cadastrada como "DDU". Não exija a palavra DDU se 2RS estiver visível. "ZZ" NÃO é equivalente a DDU/2RS.
APROVADO somente se marca, modelo, quantidade e variante compatível estiverem claramente confirmados.
REPROVADO se houver marca/modelo/quantidade/variante claramente diferente.
INCONCLUSIVO se não houver evidência visual suficiente. Nunca aprove só por formato/cor/semelhança.
Retorne SOMENTE JSON válido:
{"status":"APROVADO|REPROVADO|INCONCLUSIVO","identified_brand":null,"identified_model":null,"identified_quantity":null,"visible_markings":null,"identified_seal":null,"reason":null}`;
  const api=await fetch("https://api.openai.com/v1/responses",{method:"POST",headers:{"authorization":`Bearer ${key}`,"content-type":"application/json"},
   body:JSON.stringify({model:Netlify.env.get("OPENAI_VISION_MODEL")||"gpt-5.6-luna",input:[{role:"user",content:[{type:"input_text",text:instruction},{type:"input_image",image_url:dataUrl}]}],max_output_tokens:500})});
  const raw=await api.text();if(!api.ok){let m=raw;try{m=JSON.parse(raw)?.error?.message||raw}catch{}return json({error:`OpenAI (${api.status}): ${m}`},502)}
  const r=JSON.parse(raw);let text=r.output_text||"";if(!text&&Array.isArray(r.output))for(const it of r.output)if(Array.isArray(it.content))for(const c of it.content)if(c.type==="output_text"&&c.text)text+=c.text;
  text=text.replace(/```json/gi,"").replace(/```/g,"").trim();let d;try{d=JSON.parse(text)}catch{return json({error:"A IA respondeu em formato inválido.",raw:text},502)}
  const norm=v=>String(v||"").toUpperCase().replace(/\s+/g," ").trim(),mark=norm(d.visible_markings),seal=norm(d.identified_seal),ib=norm(d.identified_brand),im=norm(d.identified_model);
  const eb=norm(exp.brand),em=norm(exp.model),isHCH=eb==="HCH",shows2RS=mark.includes("2RS")||seal.includes("2RS"),showsDDU=mark.includes("DDU")||seal.includes("DDU"),showsZZ=mark.includes("ZZ")||seal.includes("ZZ"),expectedDDU=norm(exp.seal)==="DDU"||norm(exp.description).includes("2RS")||norm(exp.description).includes("DDU");
  if(im&&em&&im!==em){d.status="REPROVADO";d.reason=`Modelo incorreto. Esperado ${exp.model}, identificado ${d.identified_model}.`}
  if(ib&&eb&&ib!==eb){d.status="REPROVADO";d.reason=`Marca incorreta. Esperado ${exp.brand}, identificado ${d.identified_brand}.`}
  if(d.identified_quantity!=null&&Number(d.identified_quantity)!==qty){d.status="REPROVADO";d.reason=`Quantidade incorreta. Esperado ${qty}, identificado ${d.identified_quantity}.`}
  if(isHCH&&expectedDDU&&showsZZ){d.status="REPROVADO";d.reason="Vedação incorreta. Esperado DDU/2RS, mas a embalagem mostra ZZ."}
  const modelOK=!em||im===em||mark.includes(em),brandOK=!eb||ib===eb||mark.includes(eb),qtyOK=Number(d.identified_quantity)===qty,sealOK=!(isHCH&&expectedDDU)||((shows2RS||showsDDU)&&!showsZZ);
  if(d.status==="APROVADO"&&(!modelOK||!brandOK||!qtyOK||!sealOK)){d.status="INCONCLUSIVO";d.reason="A fotografia não permite confirmar com segurança todos os dados necessários."}
  if(isHCH&&expectedDDU&&modelOK&&brandOK&&qtyOK&&shows2RS&&!showsZZ){d.status="APROVADO";d.identified_seal="DDU (equivalente HCH 2RS)";d.reason=`Produto confirmado: ${exp.brand} ${exp.model}, ${qty} unidade(s). Para HCH, 2RS é equivalente a DDU.`}
  return json(d);
 }catch(e){return json({error:e?.message||"Erro interno na análise."},500)}
