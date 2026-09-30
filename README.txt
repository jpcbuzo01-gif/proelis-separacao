PROELIS V4.2 — CORREÇÃO DO ERRO 404 NO NETLIFY

O erro "Servidor retornou 404" significa que o navegador tentou chamar /api/verify,
mas essa rota não estava publicada no deploy.

Nesta versão o frontend chama diretamente:
  /.netlify/functions/verify

IMPORTANTE — FAÇA O DEPLOY DA PASTA INTEIRA:
proelis_v4_2_netlify/
  index.html
  netlify.toml
  netlify/
    functions/
      verify.mjs

Não envie somente index.html.

PASSOS:
1. Descompacte o ZIP.
2. No Netlify, faça novo deploy usando a pasta descompactada inteira.
3. Confirme que OPENAI_API_KEY continua configurada em Environment variables.
4. Faça o deploy.
5. Antes de testar a foto, abra no navegador:
   https://SEU-SITE.netlify.app/.netlify/functions/verify
   Se a Function estiver publicada, deve aparecer uma resposta JSON de "Método não permitido"
   (isso é BOM: significa que a rota existe). Se aparecer página 404, a pasta functions não foi implantada.
6. Volte à página principal e teste a foto.

Fluxo:
- 2 x HCH 6201 correto -> APROVADO -> avança.
- 6201 quando o sistema pede 6202 -> REPROVADO.
- marcação ilegível -> INCONCLUSIVO.
