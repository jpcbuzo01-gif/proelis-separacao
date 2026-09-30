const CATALOG = {
  "485": {
    ref: "485",
    description: "Rolamento HCH 6201 2RS DDU C3",
    brand: "HCH",
    model: "6201",
    seal: "DDU"
  },

  "486": {
    ref: "486",
    description: "Rolamento HCH 6202 2RS DDU C3",
    brand: "HCH",
    model: "6202",
    seal: "DDU"
  }
};

const json = (o, s = 200) =>
  new Response(JSON.stringify(o), {
    status: s,
    headers: {
      "content-type": "application/json; charset=utf-8"
    }
  });

export default async (req) => {

  if (req.method !== "POST") {
    return json({ error: "Método não permitido" }, 405);
  }

  try {

    const key = Netlify.env.get("OPENAI_API_KEY");

    if (!key) {
      return json({
        error: "OPENAI_API_KEY não configurada no Netlify."
      }, 500);
    }

    const form = await req.formData();

    const ref = String(form.get("ref") || "");
    const qty = Number(form.get("qty"));
    const photo = form.get("photo");

    const exp = CATALOG[ref];

    if (!exp || !photo || typeof photo.arrayBuffer !== "function") {
      return json({
        error: "Referência ou foto ausente."
      }, 400);
    }

    const bytes = new Uint8Array(
      await photo.arrayBuffer()
    );

    if (bytes.byteLength > 4_000_000) {
      return json({
        error: "Foto ainda está grande demais após compressão."
      }, 413);
    }

    let binary = "";

    for (let n = 0; n < bytes.length; n += 0x8000) {
      binary += String.fromCharCode(
        ...bytes.subarray(n, n + 0x8000)
      );
    }

    const dataUrl =
      "data:image/jpeg;base64," + btoa(binary);


    /*
    ==========================================================
    REGRAS DE IDENTIFICAÇÃO
    ==========================================================

    REGRA ESPECÍFICA PARA ROLAMENTOS HCH:

    - Para produtos HCH, a marcação "2RS" na embalagem
      corresponde à vedação cadastrada internamente como DDU.

    - Portanto:
          HCH + 6201 + 2RS C3
      deve ser considerado equivalente a:
          HCH + 6201 + DDU C3

    - NÃO é necessário que a palavra "DDU" esteja escrita
      fisicamente na embalagem HCH.

    - Se estiver escrito "ZZ", NÃO considerar equivalente a DDU.

    Exemplos:

    Esperado:
      HCH 6201 DDU C3

    Foto:
      HCH 6201 2RS C3

    Resultado:
      APROVADO, desde que quantidade esteja correta.


    Esperado:
      HCH 6201 DDU C3

    Foto:
      HCH 6201 ZZ C3

    Resultado:
      REPROVADO.


    Também é obrigatório confirmar:
    - marca
    - modelo
    - quantidade
    ==========================================================
    */

    const instruction = `
Você é o sistema de conferência de estoque da Proelis.

Analise SOMENTE evidências visuais presentes na fotografia.

PRODUTO ESPERADO:

Referência interna Proelis: ${exp.ref}
Descrição: ${exp.description}
Marca esperada: ${exp.brand}
Modelo esperado: ${exp.model}
Vedação cadastrada: ${exp.seal}
Quantidade esperada: ${qty}


REGRA ESPECIAL E OBRIGATÓRIA PARA ROLAMENTOS HCH:

Nos rolamentos da marca HCH, a marcação "2RS" corresponde à
vedação que a Proelis cadastra como "DDU".

Portanto:

"2RS" = "DDU" quando a marca for HCH.

Exemplo:

HCH 6201 2RS C3
é compatível com
HCH 6201 DDU C3.

NÃO exija que a palavra "DDU" esteja impressa na caixa
quando estiver claramente escrito "2RS".

Por outro lado:

"ZZ" NÃO é equivalente a "DDU" ou "2RS".

Se o produto esperado for DDU/2RS e a embalagem mostrar ZZ,
o resultado deve ser REPROVADO.


CRITÉRIOS:

APROVADO:

Somente quando for possível confirmar visualmente:

1. Marca correta;
2. Modelo correto;
3. Quantidade correta;
4. Vedação/variante compatível.

Para HCH, considere 2RS e DDU como equivalentes.


REPROVADO:

Quando houver evidência visual clara de:

- marca diferente;
- modelo diferente;
- quantidade diferente;
- variante diferente;
- ZZ quando o esperado for DDU/2RS;
- DDU/2RS quando o esperado for ZZ.


INCONCLUSIVO:

Quando a fotografia não permitir ler ou confirmar
com segurança marca, modelo ou quantidade.

Não reprove apenas porque a palavra DDU não aparece
na embalagem HCH se estiver claramente escrito 2RS.


IMPORTANTE:

Nunca aprove por formato, tamanho, cor ou semelhança
visual da embalagem.

Leia etiquetas, gravações e marcações visíveis.

Conte as unidades visíveis.


Retorne SOMENTE JSON válido neste formato:

{
  "status": "APROVADO|REPROVADO|INCONCLUSIVO",
  "identified_brand": null,
  "identified_model": null,
  "identified_quantity": null,
  "visible_markings": null,
  "identified_seal": null,
  "reason": null
}
`;


    const api = await fetch(
      "https://api.openai.com/v1/responses",
      {
        method: "POST",

        headers: {
          "authorization": `Bearer ${key}`,
          "content-type": "application/json"
        },

        body: JSON.stringify({

          model:
            Netlify.env.get("OPENAI_VISION_MODEL") ||
            "gpt-5.6-luna",

          input: [
            {
              role: "user",

              content: [
                {
                  type: "input_text",
                  text: instruction
                },

                {
                  type: "input_image",
                  image_url: dataUrl
                }
              ]
            }
          ],

          max_output_tokens: 500
        })
      }
    );


    const raw = await api.text();


    if (!api.ok) {

      let message = raw;

      try {

        const errorJson = JSON.parse(raw);

        message =
          errorJson?.error?.message ||
          raw;

      } catch {}

      return json({
        error: `OpenAI (${api.status}): ${message}`
      }, 502);
    }


    const result = JSON.parse(raw);

    let text = result.output_text || "";


    if (!text && Array.isArray(result.output)) {

      for (const item of result.output) {

        if (!Array.isArray(item.content)) continue;

        for (const c of item.content) {

          if (c.type === "output_text" && c.text) {
            text += c.text;
          }
        }
      }
    }


    text = text
      .replace(/```json/gi, "")
      .replace(/```/g, "")
      .trim();


    let parsed;

    try {

      parsed = JSON.parse(text);

    } catch {

      return json({
        error: "A IA respondeu em formato inválido.",
        raw: text
      }, 502);
    }


    /*
    ==========================================================
    NORMALIZAÇÃO
    ==========================================================
    */

    const normalize = (v) =>
      String(v || "")
        .toUpperCase()
        .replace(/\s+/g, " ")
        .trim();


    const expectedBrand = normalize(exp.brand);
    const expectedModel = normalize(exp.model);

    const identifiedBrand =
      normalize(parsed.identified_brand);

    const identifiedModel =
      normalize(parsed.identified_model);

    const markings =
      normalize(parsed.visible_markings);

    const identifiedSeal =
      normalize(parsed.identified_seal);


    /*
    ==========================================================
    REGRA HCH: 2RS = DDU
    ==========================================================
    */

    const isHCH =
      expectedBrand === "HCH";

    const photoShows2RS =
      markings.includes("2RS") ||
      identifiedSeal.includes("2RS");

    const photoShowsDDU =
      markings.includes("DDU") ||
      identifiedSeal.includes("DDU");

    const photoShowsZZ =
      markings.includes("ZZ") ||
      identifiedSeal.includes("ZZ");


    const expectedDDU =
      normalize(exp.seal) === "DDU" ||
      normalize(exp.description).includes("DDU") ||
      normalize(exp.description).includes("2RS");


    /*
    ==========================================================
    TRAVAS DETERMINÍSTICAS
    ==========================================================
    */


    // MODELO ERRADO
    if (
      identifiedModel &&
      identifiedModel !== expectedModel
    ) {

      parsed.status = "REPROVADO";

      parsed.reason =
        `Modelo incorreto. Esperado ${exp.model}, ` +
        `identificado ${parsed.identified_model}.`;
    }


    // MARCA ERRADA
    if (
      identifiedBrand &&
      identifiedBrand !== expectedBrand
    ) {

      parsed.status = "REPROVADO";

      parsed.reason =
        `Marca incorreta. Esperado ${exp.brand}, ` +
        `identificado ${parsed.identified_brand}.`;
    }


    // QUANTIDADE ERRADA
    if (
      parsed.identified_quantity !== null &&
      parsed.identified_quantity !== undefined &&
      Number(parsed.identified_quantity) !== qty
    ) {

      parsed.status = "REPROVADO";

      parsed.reason =
        `Quantidade incorreta. Esperado ${qty}, ` +
        `identificado ${parsed.identified_quantity}.`;
    }


    /*
    ==========================================================
    VEDAÇÃO HCH
    ==========================================================
    */

    if (isHCH && expectedDDU) {

      // ZZ é diferente de DDU/2RS
      if (photoShowsZZ) {

        parsed.status = "REPROVADO";

        parsed.reason =
          "Vedação incorreta. O produto esperado é DDU/2RS, " +
          "mas a embalagem mostra ZZ.";
      }

      // 2RS confirma DDU
      else if (photoShows2RS || photoShowsDDU) {

        parsed.identified_seal = "DDU (equivalente HCH 2RS)";
      }
    }


    /*
    ==========================================================
    APROVAÇÃO FINAL
    ==========================================================
    */

    const modelConfirmed =
      identifiedModel === expectedModel ||
      markings.includes(expectedModel);


    const brandConfirmed =
      identifiedBrand === expectedBrand ||
      markings.includes(expectedBrand);


    const qtyConfirmed =
      Number(parsed.identified_quantity) === qty;


    let sealConfirmed = true;


    if (isHCH && expectedDDU) {

      sealConfirmed =
        (photoShows2RS || photoShowsDDU) &&
        !photoShowsZZ;
    }


    /*
    Se a IA retornou APROVADO, exigimos evidência explícita.
    */

    if (parsed.status === "APROVADO") {

      if (
        !modelConfirmed ||
        !brandConfirmed ||
        !qtyConfirmed ||
        !sealConfirmed
      ) {

        parsed.status = "INCONCLUSIVO";

        parsed.reason =
          "A fotografia não permite confirmar com segurança " +
          "todos os dados necessários.";
      }
    }


    /*
    Caso especial HCH:
    se tudo estiver confirmado e 2RS estiver visível,
    podemos aprovar mesmo que a IA tenha ficado inconclusiva
    apenas pela ausência da palavra DDU.
    */

    if (
      isHCH &&
      expectedDDU &&
      modelConfirmed &&
      brandConfirmed &&
      qtyConfirmed &&
      photoShows2RS &&
      !photoShowsZZ
    ) {

      parsed.status = "APROVADO";

      parsed.identified_seal =
        "DDU (equivalente HCH 2RS)";

      parsed.reason =
        `Produto confirmado: ${exp.brand} ${exp.model}, ` +
        `${qty} unidade(s). Para HCH, a marcação 2RS ` +
        `é equivalente à vedação DDU.`;
    }


    return json(parsed);


  } catch (err) {

    return json({
      error:
        err?.message ||
        "Erro interno na análise."
    }, 500);
  }
};
