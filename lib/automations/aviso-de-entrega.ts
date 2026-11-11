/**
 * Confirmação que a Meta aceitou e depois NÃO entregou não pode ficar "enviada".
 *
 * B'Laser Parnamirim, 11/11: a paciente cadastrada no Belle com número de Portugal
 * (+351) entrou no CRM como +55 81…, a confirmação saiu para esse número inexistente e a
 * Meta devolveu "mensagem não entregável" (131026) — pelo webhook de status, depois do
 * envio. A linha do envio continuou `sent`, a Central não disse nada, e a clínica soube
 * pela própria paciente.
 *
 * Aqui o retorno da Meta fecha o laço: a linha do envio passa a `failed` com o motivo, e
 * UM aviso por envio abre na Central dizendo quem não recebeu e para qual número foi.
 * Não reenvia (envio em dobro é pior) — o aviso existe para a recepção ligar.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";

const KIND = "automation_rule_failed";
const REF_KIND = "template_automation_send";

export async function registrarEntregaFalhada(
  admin: SupabaseClient,
  organizationId: string,
  externalId: string,
  motivo: string | null,
): Promise<"aviso_aberto" | "sem_envio_de_automacao" | "ja_avisado"> {
  const { data: envio } = await admin
    .from("whatsapp_template_automation_sends")
    .select("id, status, contact_id, appointment_id, automation_id")
    .eq("organization_id", organizationId)
    .eq("external_id", externalId)
    .maybeSingle();
  if (!envio) return "sem_envio_de_automacao"; // mensagem comum ou de campanha: não é daqui

  const motivoTexto = (motivo ?? "a Meta não informou o motivo").slice(0, 300);
  if (envio.status === "sent") {
    await admin
      .from("whatsapp_template_automation_sends")
      .update({ status: "failed", error_message: `entrega falhou: ${motivoTexto}` })
      .eq("id", envio.id)
      .eq("status", "sent");
  }

  const { data: jaAberto } = await admin
    .from("agent_inbox_items")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("kind", KIND)
    .eq("ref_kind", REF_KIND)
    .eq("ref_id", envio.id)
    .limit(1)
    .maybeSingle();
  if (jaAberto) return "ja_avisado";

  const [{ data: contato }, { data: consulta }, { data: automacao }] = await Promise.all([
    admin.from("contacts").select("display_name, name, phone_number").eq("id", envio.contact_id).maybeSingle(),
    envio.appointment_id
      ? admin.from("calendar_appointments").select("starts_at, time_zone").eq("id", envio.appointment_id).maybeSingle()
      : Promise.resolve({ data: null }),
    admin.from("whatsapp_template_automations").select("name").eq("id", envio.automation_id).maybeSingle(),
  ]);
  const nome = contato?.display_name ?? contato?.name ?? "Paciente";
  const quando = consulta?.starts_at
    ? new Date(consulta.starts_at as string).toLocaleString("pt-BR", {
        timeZone: (consulta.time_zone as string | null) ?? "America/Sao_Paulo",
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      })
    : null;

  const { error } = await admin.from("agent_inbox_items").insert({
    organization_id: organizationId,
    kind: KIND,
    severity: "warn",
    title: `${nome} não recebeu a confirmação`,
    body:
      `A mensagem "${automacao?.name ?? "confirmação"}"${quando ? ` (consulta ${quando})` : ""} foi enviada para ` +
      `${contato?.phone_number ?? "o número cadastrado"}, mas o WhatsApp não conseguiu entregar: ${motivoTexto}. ` +
      "O número pode estar errado no cadastro (paciente de outro país, por exemplo). " +
      "Avise a paciente por outro meio e corrija o número.",
    ref_kind: REF_KIND,
    ref_id: envio.id,
  });
  if (error) {
    logger.error("[automations/aviso-entrega] não abriu o aviso na Central", {
      organization_id: organizationId,
      send_id: envio.id,
      error: error.message,
    });
  }
  return "aviso_aberto";
}
