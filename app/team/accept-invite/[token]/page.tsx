/**
 * /team/accept-invite/[token] — public route (added to PUBLIC_PATHS).
 *
 * Behavior matrix:
 *  - Invalid/expired token         → render error
 *  - Unauthenticated user          → render CTA → /login?next=...
 *  - Authenticated, email mismatch → render mismatch + sign-out CTA
 *  - Authenticated, email match    → form posts to Server Action which inserts
 *                                    membership and redirects to /app/inbox
 */
import Link from "next/link";

import { verifyInviteToken } from "@/lib/auth/invite-token";
import { emailTemConta } from "@/lib/auth/conta-existente";
import { authRateLimited, AUTH_LIMITS } from "@/lib/auth/rate-limit";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { acceptInviteAction } from "@/app/actions/team/acceptInvite";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ token: string }>;
}

export default async function AcceptInvitePage({ params }: PageProps) {
  const { token } = await params;

  // O gargalo de enumeração é AQUI, não no aceite: a rota é pública e cada
  // GET testa um token. Sem teto, varrer o espaço de tokens sai de graça
  // (issue #64). Barrar antes de verificar mantém a resposta indistinguível
  // entre token válido e inválido para quem está varrendo.
  if (await authRateLimited("invite_accept", null, AUTH_LIMITS.invite_accept)) {
    return (
      <Shell>
        <h1 className="text-xl font-semibold">Muitas tentativas</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Aguarde alguns minutos e abra o link do convite de novo.
        </p>
      </Shell>
    );
  }

  const payload = verifyInviteToken(token);

  if (!payload) {
    return (
      <Shell>
        <h1 className="text-xl font-semibold">Convite inválido ou expirado</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Este link não é válido ou já passou da janela de 24h. Peça um novo convite ao admin do tenant.
        </p>
      </Shell>
    );
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    const next = encodeURIComponent(`/team/accept-invite/${token}`);
    const entrar = `/login?next=${next}`;
    const criarConta = `/signup?invite=${encodeURIComponent(token)}`;

    /*
      UMA PORTA SÓ — quem decide é o servidor, não a pessoa.

      Esta tela oferecia "Fazer login" E "Ainda não tenho conta", e errar a
      escolha prendia a pessoa PERMANENTEMENTE: o GoTrue não atualiza
      `user_metadata` de conta que já existe, então o convite novo era
      descartado e o token velho (expirado) era o que `/auth/confirm` lia —
      para sempre, convite após convite. Aconteceu com a gerente da B'Laser
      Gravatá; o cabeçalho da migration 0188 tem o rastro completo.

      Ninguém que recebe um convite sabe de cor se criou conta semanas atrás.
      O servidor sabe, então o servidor responde.
    */
    const temConta = await emailTemConta(createAdminClient(), payload.email);

    return (
      <Shell>
        <h1 className="text-xl font-semibold">Você foi convidado</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Entrar como <strong>{payload.role}</strong>, com o e-mail{" "}
          <strong>{payload.email}</strong>.
        </p>

        {temConta === true && (
          <>
            <p className="mt-3 text-sm text-muted-foreground">
              Você já tem uma conta com esse e-mail. Entre com sua senha para concluir.
            </p>
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <Link
                href={entrar}
                className="inline-block rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
              >
                Entrar e aceitar
              </Link>
              <Link href="/login/forgot" className="text-sm underline underline-offset-4">
                Esqueci minha senha
              </Link>
            </div>
          </>
        )}

        {temConta === false && (
          <>
            <p className="mt-3 text-sm text-muted-foreground">
              Você ainda não tem conta. Crie uma senha para concluir — leva menos de um minuto.
            </p>
            <div className="mt-4">
              <Link
                href={criarConta}
                className="inline-block rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
              >
                Criar conta e aceitar
              </Link>
            </div>
          </>
        )}

        {/*
          Consulta indisponível: oferecer as duas portas é o comportamento
          ANTIGO, e é o degradê honesto — a tela diz que não sabe, em vez de
          chutar. Chutar "não tem conta" devolveria a armadilha exatamente no
          dia em que o banco está ruim.
        */}
        {temConta === null && (
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Link
              href={entrar}
              className="inline-block rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
            >
              Já tenho conta — entrar
            </Link>
            <Link href={criarConta} className="text-sm underline underline-offset-4">
              Criar conta
            </Link>
          </div>
        )}
      </Shell>
    );
  }

  const userEmail = (user.email ?? "").trim().toLowerCase();
  if (userEmail !== payload.email.trim().toLowerCase()) {
    return (
      <Shell>
        <h1 className="text-xl font-semibold">Email não corresponde</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Você está logado como <strong>{user.email}</strong>, mas o convite foi enviado para{" "}
          <strong>{payload.email}</strong>. Saia e faça login com o email correto.
        </p>
        <form action="/api/auth/signout" method="post" className="mt-4">
          <button
            type="submit"
            className="rounded-md border px-4 py-2 text-sm font-medium hover:bg-accent"
          >
            Sair
          </button>
        </form>
      </Shell>
    );
  }

  async function accept() {
    "use server";
    await acceptInviteAction(token);
  }

  return (
    <Shell>
      <h1 className="text-xl font-semibold">Aceitar convite</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Você foi convidado para entrar como <strong>{payload.role}</strong>. Confirme abaixo para
        ativar seu acesso.
      </p>
      <form action={accept} className="mt-4">
        <button
          type="submit"
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
        >
          Aceitar convite
        </button>
      </form>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-md rounded-lg border bg-card p-8 shadow-sm">{children}</div>
    </div>
  );
}
