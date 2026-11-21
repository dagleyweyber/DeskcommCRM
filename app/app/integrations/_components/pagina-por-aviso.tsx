/**
 * Página server das integrações que AVISAM (Uno, Zandu): confere o papel, lê a
 * conexão pela mesma rota da tela e descobre o endereço público do CRM.
 */
import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { createAdminClient } from "@/lib/supabase/admin";

import { ConexaoPorAviso, type ConexaoPorAvisoDados } from "./ConexaoPorAviso";

/**
 * O endereço PÚBLICO do CRM (o que o Uno/Zandu alcança), pelo cabeçalho do proxy.
 * `NEXT_PUBLIC_APP_URL` não serve: é fixado no build da imagem, a mesma para todo cliente.
 */
async function origemPublica(): Promise<string> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto.split(",")[0]!.trim()}://${host.split(",")[0]!.trim()}`;
}

export async function PaginaPorAviso({ provedor, titulo, descricao }: { provedor: "uno" | "zandu"; titulo: string; descricao: string }) {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  if (ROLE_RANK[activeOrg.role] < ROLE_RANK.manager) redirect("/403");
  const ehAdmin = ROLE_RANK[activeOrg.role] >= ROLE_RANK.admin;

  // Service role com filtro de org manual: o caminho do aviso não está na view segura.
  const admin = createAdminClient();
  const { data } = await admin
    .from("calendar_integrations")
    .select("id, credential_last4, external_account_id, status, last_error, last_sync_at, last_sync_stats, inbound_path_token")
    .eq("organization_id", activeOrg.orgId)
    .eq("provider", provedor)
    .maybeSingle();

  let inicial: ConexaoPorAvisoDados | null = null;
  if (data) {
    const { inbound_path_token, ...resto } = data as typeof data & { inbound_path_token: string | null };
    // Os números dos avisos vêm na 1ª atualização da tela (rota GET), poucos segundos depois.
    inicial = {
      ...(resto as Omit<ConexaoPorAvisoDados, "caminho_do_aviso" | "avisos">),
      caminho_do_aviso: ehAdmin && inbound_path_token ? `/api/v1/webhooks/agenda/${inbound_path_token}` : null,
      avisos: { recebidos_24h: 0, pendentes: 0, ultimo_recebido_em: null },
    };
  }

  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <header>
        <Link href="/app/integrations" className="text-sm text-muted-foreground hover:underline">
          ← Integrações
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">{titulo}</h1>
        <p className="text-sm text-muted-foreground">{descricao}</p>
      </header>
      <ConexaoPorAviso provedor={provedor} initialData={inicial} canWrite={ehAdmin} origem={await origemPublica()} />
    </div>
  );
}
