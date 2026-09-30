const CATALOG={
"485":{ref:"485",description:"Rolamento HCH 6201 2RS DDU C3",brand:"HCH",model:"6201",seal:"2RS DDU"},
"486":{ref:"486",description:"Rolamento HCH 6202 2RS DDU C3",brand:"HCH",model:"6202",seal:"2RS DDU"}
};
const json=(o,s=200)=>new Response(JSON.stringify(o),{status:s,headers:{"content-type":"application/json; charset=utf-8"}});
export default async(req)=>{
 if(req.method!=="POST")return json({error:"Método não permitido"},405);
 try{
  const key=Netlify.env.get("OPENAI_API_KEY");
  if(!key)return json({error:"OPENAI_API_KEY não configurada no Netlify."},500);
  const form=await req.formData(),ref=String(form.get("ref")||""),qty=Number(form.get("qty")),photo=form.get("photo"),exp=CATALOG[ref];
  if(!exp||!photo||typeof photo.arrayBuffer!=="function")return json({error:"Referência ou foto ausente."},400);
  const bytes=new Uint8Array(await photo.arrayBuffer());
  if(bytes.byteLength>4_000_000)return json({error:"Foto ainda está grande demais após compressão."},413);
  let binary="";for(let n=0;n<bytes.length;n+=0x8000)binary+=String.fromCharCode(...bytes.subarray(n,n+0x8000));
  const dataUrl="data:image/jpeg;base64,"+btoa(binary);
  const instruction=`Conferência de estoque Proelis. Use somente evidência visual.
Esperado: Ref ${exp.ref}; ${exp.description}; marca ${exp.brand}; modelo ${exp.model}; vedação ${exp.seal}; quantidade ${qty}.
Leia etiquetas/gravações e conte unidades visíveis.
APROVADO somente se modelo ${exp.model} e quantidade ${qty} estiverem claramente confirmados, sem conflito de marca/variante.
REPROVADO se houver evidência clara de marca/modelo/variante/quantidade diferente.
INCONCLUSIVO se não for possível confirmar com segurança. Nunca aprove por formato/semelhança.
Retorne somente JSON válido: {"status":"APROVADO|REPROVADO|INCONCLUSIVO","identified_brand":null,"identified_model":null,"identified_quantity":null,"visible_markings":[],"reason":"curto em português"}`;
  const api=await fetch("https://api.openai.com/v1/responses",{method:"POST",headers:{"authorization":`Bearer ${key}`,"content-type":"application/json"},body:JSON.stringify({
   model:Netlify.env.get("OPENAI_VISION_MODEL")||"gpt-5.6-luna",
   input:[{role:"user",content:[{type:"input_text",text:instruction},{type:"input_image",image_url:dataUrl}]}],
   max_output_tokens:500
  })});
  const raw=await api.json();
  if(!api.ok)return json({error:`OpenAI (${api.status}): ${raw?.error?.message||"falha na API"}`},502);
  let out="";for(const o of(raw.output||[]))for(const c of(o.content||[]))if(c.type==="output_text")out+=c.text||"";
  out=out.replace(/^```(?:json)?\s*/i,"").replace(/\s*```$/,"").trim();
  let d;try{d=JSON.parse(out)}catch{return json({status:"INCONCLUSIVO",identified_brand:null,identified_model:null,identified_quantity:null,visible_markings:[],reason:"Não foi possível interpretar a resposta da IA."})}
  let st=String(d.status||"INCONCLUSIVO").toUpperCase(),m=String(d.identified_model||"").replace(/\s/g,"").toUpperCase(),b=String(d.identified_brand||"").replace(/\s/g,"").toUpperCase(),eq=exp.model.toUpperCase();
  const q=d.identified_quantity==null?null:Number(d.identified_quantity);
  if(m&&m!==eq)st="REPROVADO";if(b&&b!==exp.brand.toUpperCase())st="REPROVADO";if(q!==null&&Number.isFinite(q)&&q!==qty)st="REPROVADO";
  if(st==="APROVADO"&&(m!==eq||q!==qty))st="INCONCLUSIVO";
  if(!["APROVADO","REPROVADO","INCONCLUSIVO"].includes(st))st="INCONCLUSIVO";
  return json({...d,status:st});
 }catch(e){return json({error:`Função Netlify: ${e?.message||String(e)}`},500)}
};
