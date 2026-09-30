const json=(o,s=200)=>new Response(JSON.stringify(o),{status:s,headers:{"content-type":"application/json; charset=utf-8"}});
export default async(req)=>{
 if(req.method!=="POST")return json({error:"Método não permitido"},405);
 try{
  const key=Netlify.env.get("OPENAI_API_KEY"); if(!key)return json({error:"OPENAI_API_KEY não configurada no Netlify."},500);
  const form=await req.formData(),photo=form.get("photo"); if(!photo||typeof photo.arrayBuffer!=="function")return json({error:"Foto do pedido ausente."},400);
  const bytes=new Uint8Array(await photo.arrayBuffer()); if(bytes.byteLength>5_000_000)return json({error:"Foto grande demais."},413);
  let binary="";for(let n=0;n<bytes.length;n+=0x8000)binary+=String.fromCharCode(...bytes.subarray(n,n+0x8000));
  const dataUrl="data:image/jpeg;base64,"+btoa(binary);
  const instruction=`Leia esta foto de uma "Separação de Mercadoria" da Proelis.
Extraia o cabeçalho quando legível: número da Venda, Data e Cliente.
Na tabela, extraia SOMENTE as linhas de produtos. Ignore anotações manuscritas, vistos/checks, localização e observações.
A coluna "Codigo" é a REFERÊNCIA INTERNA PROELIS e deve ser copiada exatamente.
Para cada linha, retorne Qtde, Codigo e Descrição impressos. Não invente linhas ilegíveis.
Se uma linha estiver parcialmente ilegível, ainda retorne apenas quando Código e Quantidade forem legíveis; preserve a descrição visível.
Retorne SOMENTE JSON válido:
{"sale_number":null,"date":null,"client":null,"items":[{"qty":1,"ref":"485","description":"ROLAMENTO HCH 6201 2RS"}]}`;
  const api=await fetch("https://api.openai.com/v1/responses",{method:"POST",headers:{"authorization":`Bearer ${key}`,"content-type":"application/json"},
   body:JSON.stringify({model:Netlify.env.get("OPENAI_VISION_MODEL")||"gpt-5.6-luna",input:[{role:"user",content:[{type:"input_text",text:instruction},{type:"input_image",image_url:dataUrl}]}],max_output_tokens:1800})});
  const raw=await api.text(); if(!api.ok){let m=raw;try{m=JSON.parse(raw)?.error?.message||raw}catch{}return json({error:`OpenAI (${api.status}): ${m}`},502)}
  const r=JSON.parse(raw);let text=r.output_text||"";if(!text&&Array.isArray(r.output))for(const it of r.output)if(Array.isArray(it.content))for(const c of it.content)if(c.type==="output_text"&&c.text)text+=c.text;
  text=text.replace(/```json/gi,"").replace(/```/g,"").trim();let d;try{d=JSON.parse(text)}catch{return json({error:"A IA respondeu em formato inválido.",raw:text},502)}
  d.items=(Array.isArray(d.items)?d.items:[]).filter(x=>x&&x.ref&&Number(x.qty)>0).map(x=>({qty:Number(x.qty),ref:String(x.ref).trim(),description:String(x.description||"").trim()}));
  return json(d);
 }catch(e){return json({error:e?.message||"Erro interno na leitura do pedido."},500)}
};
