const SUPABASE_URL = "https://mbxmhojgoqzqfxzajafb.supabase.co";
const PUBLISHABLE_KEY = "sb_publishable_6YxdvuPcirHBODEEylOUsQ_xsehFq_d";

const json = (statusCode, body) => ({
  statusCode,
  headers: {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "POST, OPTIONS"
  },
  body: JSON.stringify(body)
});

async function supabaseFetch(path, options = {}, key = PUBLISHABLE_KEY) {
  const headers = {
    apikey: key,
    "Content-Type": "application/json",
    ...(options.headers || {})
  };

  return fetch(`${SUPABASE_URL}${path}`, {
    ...options,
    headers
  });
}

export const handler = async (event) => {

  if (event.httpMethod === "OPTIONS")
    return json(200, { ok: true });

  if (event.httpMethod !== "POST")
    return json(405, { error: "Método não permitido." });

  try {

   const secret = process.env.SUPABASE_SECRET_KEY;

    if (!secret) {
      return json(500, {
        error: "SUPABASE_SECRET_KEY não configurada no Netlify."
      });
    }

    // JWT do administrador logado
    const authHeader =
      event.headers.authorization ||
      event.headers.Authorization ||
      "";

    const token = authHeader
      .replace(/^Bearer\s+/i, "")
      .trim();

    if (!token) {
      return json(401, {
        error: "Sessão não encontrada."
      });
    }

    // Valida o usuário logado
    const userRes = await supabaseFetch(
      "/auth/v1/user",
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`
        }
      }
    );

    const user = await userRes.json().catch(() => ({}));

    if (!userRes.ok || !user?.id) {
      return json(401, {
        error: "Sessão inválida ou expirada.",
        detail: user
      });
    }

    // Confirma que é administrador ativo
    const profileRes = await supabaseFetch(
      `/rest/v1/profiles?id=eq.${encodeURIComponent(user.id)}&select=id,role,ativo`,
      {
        method: "GET",
        headers: {
          Accept: "application/json"
        }
      },
      secret
    );

    const profiles =
      await profileRes.json().catch(() => []);

    if (!profileRes.ok) {
      return json(500, {
        error: "Não foi possível validar o administrador.",
        detail: profiles
      });
    }

    const profile = profiles?.[0];

    if (
      !profile ||
      profile.role !== "admin" ||
      profile.ativo !== true
    ) {
      return json(403, {
        error:
          "Apenas administradores ativos podem criar usuários."
      });
    }

    const body = JSON.parse(event.body || "{}");

    if (body.action !== "create") {
      return json(400, {
        error: "Ação inválida."
      });
    }

    const nome =
      String(body.nome || "").trim();

    const email =
      String(body.email || "")
        .trim()
        .toLowerCase();

    const password =
      String(body.password || "");

    const role =
      body.role === "admin"
        ? "admin"
        : "separador";

    if (!nome)
      return json(400, {
        error: "Informe o nome."
      });

    if (!email || !email.includes("@"))
      return json(400, {
        error: "Informe um e-mail válido."
      });

    if (password.length < 8)
      return json(400, {
        error:
          "A senha inicial deve ter pelo menos 8 caracteres."
      });

    // Cria usuário no Supabase Auth
    const createRes = await supabaseFetch(
      "/auth/v1/admin/users",
      {
        method: "POST",
        body: JSON.stringify({
          email,
          password,
          email_confirm: true,
          user_metadata: {
            nome
          }
        })
      },
      secret
    );

    const created =
      await createRes.json().catch(() => ({}));

    if (!createRes.ok || !created?.id) {
      return json(
        createRes.status || 400,
        {
          error:
            created?.msg ||
            created?.message ||
            created?.error_description ||
            "Falha ao criar usuário no Supabase.",
          detail: created
        }
      );
    }

    // Atualiza perfil criado pelo trigger
    const patchRes = await supabaseFetch(
      `/rest/v1/profiles?id=eq.${encodeURIComponent(created.id)}`,
      {
        method: "PATCH",
        headers: {
          Prefer: "return=representation"
        },
        body: JSON.stringify({
          nome,
          role,
          ativo: true
        })
      },
      secret
    );

    const patched =
      await patchRes.json().catch(() => []);

    if (!patchRes.ok) {
      return json(500, {
        error:
          "Usuário criado no Auth, mas houve erro ao atualizar o perfil.",
        user_id: created.id,
        detail: patched
      });
    }

    return json(200, {
      ok: true,
      message:
        "Usuário criado com sucesso.",
      user: {
        id: created.id,
        email,
        nome,
        role
      }
    });

  } catch (err) {

    return json(500, {
      error:
        err?.message ||
        "Erro interno ao criar usuário."
    });

  }
};
