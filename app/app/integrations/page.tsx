/**
 * /app/integrations — Integrações de agenda: Belle, Uno e Zandu.
 *
 * Pedido do dono do produto (2026-11-21): o item "Belle" do menu virou "Integrações".
 * Cada cartão leva à tela do sistema e mostra, sem abrir, se está conectado e quando
 * chegou o último agendamento. Lê a view segura (nunca o token).
 */
import Link from "next/link";
import { redirect } from "next/navigation";

import { Card } from "@/components/ui/card";
import { PROVEDORES_DE_AGENDA, nomeDoProvedor, type ProvedorDeAgenda } from "@/lib/agenda-externa/provedor";
import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { createClient } from "@/lib/supabase/server";
import { CalendarCheck } from "@/lib/ui/icons";

export const dynamic = "force-dynamic";

const DESCRICAO: Record<ProvedorDeAgenda, string> = {
  belle: "Belle Software. O CRM relê a agenda a cada 10 minutos e devolve ao Belle a confirmação da paciente.",
  uno: "Uno. O Uno avisa o CRM na hora a cada agendamento criado, alterado ou removido.",
  zandu: "Zandu. O Zandu avisa o CRM na hora a cada agendamento criado, alterado ou removido.",
};

interface Linha {
  provider: ProvedorDeAgenda;
  status: "healthy" | "invalid" | "error";
  last_sync_at: string | null;
}

function situacao(l: Linha | undefined): { texto: string; classe: string } {
  if (!l) return { texto: "Não conectado", classe: "text-muted-foreground" };
  if (l.status === "invalid") return { texto: "Token recusado — reconectar", classe: "text-destructive" };
  if (l.status === "error") return { texto: "Conectado, com falha recente", classe: "text-amber-600 dark:text-amber-400" };
  return { texto: "Conectado", classe: "text-emerald-600 dark:text-emerald-400" };
}

export default async function IntegracoesPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  if (ROLE_RANK[activeOrg.role] < ROLE_RANK.manager) redirect("/403");

  const supabase = await createClient();
  const { data } = await supabase
    .from("calendar_integrations_safe")
    .select("provider, status, last_sync_at")
    .eq("organization_id", activeOrg.orgId);
  const porProvedor = new Map(((data ?? []) as Linha[]).map((l) => [l.provider, l]));

  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Integrações</h1>
        <p className="text-sm text-muted-foreground">
          Conecte o sistema de gestão da clínica e todo agendamento feito nele aparece sozinho na Agenda: horário,
          sala, serviço e paciente — que entram nas automações de lembrete e confirmação pelo WhatsApp.
        </p>
      </header>
      <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {PROVEDORES_DE_AGENDA.map((p) => {
          const l = porProvedor.get(p);
          const s = situacao(l);
          return (
            <li key={p}>
              <Link href={`/app/integrations/${p}`} className="block h-full rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <Card className="flex h-full flex-col gap-3 p-5 transition-colors hover:bg-muted/50">
                  <div className="flex items-center gap-2">
                    <CalendarCheck size={22} className="text-muted-foreground" />
                    <h2 className="font-medium">{nomeDoProvedor(p)}</h2>
                  </div>
                  <p className="text-sm text-muted-foreground">{DESCRICAO[p]}</p>
                  <p className={`mt-auto text-sm font-medium ${s.classe}`}>
                    {s.texto}
                    {l?.last_sync_at && (
                      <span className="block text-xs font-normal text-muted-foreground">
                        Última atualização:{" "}
                        {new Date(l.last_sync_at).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}
                      </span>
                    )}
                  </p>
                </Card>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
