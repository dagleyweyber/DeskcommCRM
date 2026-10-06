/**
 * /team/accept-invite/[token] — public route (added to PUBLIC_PATHS).
 *
 * Behavior matrix:
 *  - Invalid/expired token         → render error
 *  - Unauthenticated user          → render CTA → /login?next=... OU /signup?invite=...,
 *                                    com a ação CORRETA em destaque (ver nota abaixo)
 *  - Authenticated, email mismatch → render mismatch + sign-out CTA
 *  - Authenticated, email match    → form posts to Server Action which inserts
 *                                    membership and redirects to /app/inbox
 *
 * Nota sobre o branch "unauthenticated" (achado ao vivo — Botulaser Curitiba,
 * 2026-10-06): as duas opções ("Fazer login" / "Ainda não tenho conta")
 * tinham o MESMO peso visual — "Fazer login" como botão grande, a outra como
 * linkzinho sublinhado. Quem está sendo convidado pela 1ª vez (o caso mais
 * comum desta tela: dono de tenant novo, criado por `POST /api/v1/admin/
 * tenants`, que NUNCA pré-cria o usuário Auth) naturalmente clica no botão
 * grande — e cai numa tela de login vazia, sem conta pra entrar, confusa sem
 * explicar o motivo. `accountExistsForEmail` checa (melhor esforço) se já
 * existe conta pro e-mail do convite, e a tela destaca a ação certa — nunca
 * esconde a outra, porque o lookup pagina só os primeiros 200 usuários
 * (mesmo limite de `useRecoveryCode.ts`) e pode errar por falso-negativo.
 */
import Link from "next/link";

import { accountExistsForEmail } from "@/lib/auth/account-exists";
import { verifyInviteToken } from "@/lib/auth/invite-token";
import { authRateLimited, AUTH_LIMITS } from "@/lib/auth/rate-limit";
import { isServiceRoleConfigured } from "@/lib/audit";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
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
    const loginHref = `/login?next=${next}`;
    const signupHref = `/signup?invite=${encodeURIComponent(token)}`;

    // Melhor esforço: já existe conta pra este e-mail? `null` (sem service
    // role, ou erro na API) degrada pro meio-termo neutro abaixo — nunca
    // derruba a tela.
    const admin = isServiceRoleConfigured() ? createAdminClient() : null;
    const accountExists = admin ? await accountExistsForEmail(admin, payload.email) : null;

    // accountExists === false (achado) OU null (não sabemos — e o caso mais
    // comum desta tela, convite de dono de tenant novo, é justamente não ter
    // conta ainda) ⇒ "Criar conta" é a ação em destaque. Só quando SABEMOS
    // que já existe conta é que "Fazer login" vira o botão primário.
    const primaryIsLogin = accountExists === true;
    const primaryHref = primaryIsLogin ? loginHref : signupHref;
    const primaryLabel = primaryIsLogin ? "Fazer login" : "Criar conta";
    const secondaryHref = primaryIsLogin ? signupHref : loginHref;
    const secondaryLabel = primaryIsLogin ? "Ainda não tenho conta" : "Já tenho conta, fazer login";

    return (
      <Shell>
        <h1 className="text-xl font-semibold">Você foi convidado</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Para aceitar o convite como <strong>{payload.role}</strong>, continue com o email{" "}
          <strong>{payload.email}</strong>.
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Link
            href={primaryHref}
            className="inline-block rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
          >
            {primaryLabel}
          </Link>
          {/*
            O caminho que faltava. Quem é convidado e ainda NÃO tem conta só
            tinha "Fazer login" — então criava conta pelo caminho comum, e o
            provisionamento, sem achar vínculo, abria uma empresa e o tornava
            admin dela. O token viaja no link para que a conta nova já nasça
            amarrada a este convite. Continua presente mesmo quando não é a
            ação em destaque — o lookup é melhor-esforço, nunca remove caminho.
          */}
          <Link href={secondaryHref} className="text-sm underline underline-offset-4">
            {secondaryLabel}
          </Link>
        </div>
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
