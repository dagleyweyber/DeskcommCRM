/**
 * Automação que não consegue consultar quem está devido NÃO pode falhar calada.
 *
 * B'Laser Parnamirim, 06/11 e 10/11: a consulta da confirmação de Laser estourou o
 * tempo do banco a cada tick, o resolvedor escrevia no log e devolvia "ninguém
 * devido" — 54 pacientes sem confirmação, e a clínica descobriu pelo paciente.
 *
 * Aqui a falha vira UM aviso crítico na Central (kind `automation_rule_failed`, o
 * mesmo das regras de automação — para quem lê, é "uma automação parou"), preso à
 * automação por `ref_kind`/`ref_id`: uma automação quebrada abre um aviso, não um
 * por tick. E o laço volta sozinho: no primeiro tick em que a consulta funciona, o
 * aviso aberto é resolvido — a Central não fica com um alarme que já passou.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";

const KIND = "automation_rule_failed";
const REF_KIND = "template_automation";

export interface AutomacaoDoAviso {
  id: string;
  organization_id: string;
  name: string;
}

export async function abrirAvisoDeFalha(
  admin: SupabaseClient,
  automacao: AutomacaoDoAviso,
  motivoTecnico: string,
): Promise<"criado" | "ja_aberto"> {
  const { data: jaAberto } = await admin
    .from("agent_inbox_items")
    .select("id")
    .eq("organization_id", automacao.organization_id)
    .eq("kind", KIND)
    .eq("ref_kind", REF_KIND)
    .eq("ref_id", automacao.id)
    .eq("status", "open")
    .limit(1)
    .maybeSingle();
  if (jaAberto) return "ja_aberto";

  const { error } = await admin.from("agent_inbox_items").insert({
    organization_id: automacao.organization_id,
    kind: KIND,
    severity: "critical",
    title: `A automação "${automacao.name}" parou de enviar`,
    body:
      "O sistema não conseguiu consultar a agenda para saber quem deve receber esta mensagem, " +
      "e ninguém está recebendo enquanto isso não voltar. Ele tenta de novo a cada minuto e " +
      "este aviso se fecha sozinho quando voltar a funcionar. Se continuar aberto, confira os " +
      `envios pendentes desta automação. Motivo técnico: ${motivoTecnico.slice(0, 300)}`,
    ref_kind: REF_KIND,
    ref_id: automacao.id,
  });
  if (error) {
    logger.error("[automations/aviso] não abriu o aviso na Central", {
      automation_id: automacao.id,
      organization_id: automacao.organization_id,
      error: error.message,
    });
  }
  return "criado";
}

/** A consulta voltou a funcionar: o aviso aberto desta automação deixa de valer. */
export async function fecharAvisoDeFalha(admin: SupabaseClient, automacao: AutomacaoDoAviso): Promise<void> {
  await admin
    .from("agent_inbox_items")
    .update({ status: "resolved" })
    .eq("organization_id", automacao.organization_id)
    .eq("kind", KIND)
    .eq("ref_kind", REF_KIND)
    .eq("ref_id", automacao.id)
    .eq("status", "open");
}
