/**
 * Regras que recortam o público de uma campanha DEPOIS do filtro (tag, etapa,
 * todos): quem já recebeu campanha há pouco sai, e o total pode ter teto.
 *
 * Por que existe: o dono do produto quer mandar uma base grande em partes —
 * 1.000 hoje, o resto amanhã — sem ninguém receber duas vezes (2026-11-08).
 * As duas regras andam juntas: só o teto repetiria os mesmos 1.000 amanhã, só a
 * exclusão mandaria para todos no primeiro dia.
 *
 * "Recebeu" = destinatário de campanha com `status = 'sent'` no período, de
 * QUALQUER campanha da organização (decisão do dono: conversa e automação não
 * contam). Também sai quem está na FILA de uma campanha em andamento
 * (`pending` em campanha `queued`/`running`/`paused`): ainda não recebeu, mas
 * vai — sem isto, criar a segunda leva enquanto a primeira sai repetiria gente.
 * Rascunho não conta: pode nunca ser disparado.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import type { AudienceMember } from "./audience";

/** As janelas que a tela oferece. Valor fora delas é recusado pela API. */
export const JANELAS_EM_DIAS = [1, 2, 3, 4, 7] as const;
export type JanelaEmDias = (typeof JANELAS_EM_DIAS)[number];

/** Campos das regras no corpo da criação e da contagem (snake_case, como a API). */
export const regrasDeEnvioSchema = z.object({
  excluir_quem_recebeu_dias: z
    .union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(7)])
    .nullable()
    .optional(),
  limite: z.number().int().min(1).max(100_000).nullable().optional(),
});

export function regrasDoCorpo(r: z.infer<typeof regrasDeEnvioSchema>): RegrasDeEnvio {
  return { excluirQuemRecebeuDias: r.excluir_quem_recebeu_dias ?? null, limite: r.limite ?? null };
}

export interface RegrasDeEnvio {
  excluirQuemRecebeuDias?: JanelaEmDias | null;
  limite?: number | null;
}

export interface PublicoRecortado {
  selecionados: AudienceMember[];
  /** Quantos o filtro achou antes das regras. */
  doFiltro: number;
  excluidosPorRecente: number;
  cortadosPeloLimite: number;
}

const PAGINA = 1000;
const STATUS_EM_ANDAMENTO = ["queued", "running", "paused"];

/** Lê uma consulta inteira, página a página (o PostgREST corta em 1.000 sem erro). */
async function todasAsPaginas<T>(
  pagina: (de: number, ate: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const out: T[] = [];
  for (let de = 0; ; de += PAGINA) {
    const { data, error } = await pagina(de, de + PAGINA - 1);
    // Falha no meio não pode virar "ninguém recebeu": isso mandaria em dobro.
    if (error) throw new Error(`regras_de_envio_read_failed: ${error.message}`);
    out.push(...(data ?? []));
    if ((data ?? []).length < PAGINA) return out;
  }
}

/** Contatos que receberam campanha desde `desde`, ou estão na fila de uma em andamento. */
export async function contatosQueReceberamCampanha(
  admin: SupabaseClient,
  organizationId: string,
  desde: Date,
): Promise<Set<string>> {
  const enviados = await todasAsPaginas<{ contact_id: string }>((de, ate) =>
    admin
      .from("whatsapp_campaign_recipients")
      .select("contact_id")
      .eq("organization_id", organizationId)
      .eq("status", "sent")
      .gte("sent_at", desde.toISOString())
      .order("id", { ascending: true })
      .range(de, ate),
  );

  const { data: emAndamento, error } = await admin
    .from("whatsapp_campaigns")
    .select("id")
    .eq("organization_id", organizationId)
    .in("status", STATUS_EM_ANDAMENTO);
  if (error) throw new Error(`regras_de_envio_read_failed: ${error.message}`);

  const ids = ((emAndamento ?? []) as Array<{ id: string }>).map((c) => c.id);
  const naFila =
    ids.length === 0
      ? []
      : await todasAsPaginas<{ contact_id: string }>((de, ate) =>
          admin
            .from("whatsapp_campaign_recipients")
            .select("contact_id")
            .eq("organization_id", organizationId)
            .eq("status", "pending")
            .in("campaign_id", ids)
            .order("id", { ascending: true })
            .range(de, ate),
        );

  return new Set([...enviados, ...naFila].map((r) => r.contact_id));
}

/** Aplica as regras ao público já resolvido. Pura: quem lê o banco é o chamador. */
export function recortarPublico(
  publico: AudienceMember[],
  jaReceberam: Set<string>,
  limite: number | null | undefined,
): PublicoRecortado {
  const semRecentes = publico.filter((m) => !jaReceberam.has(m.contactId));
  const selecionados = limite ? semRecentes.slice(0, limite) : semRecentes;
  return {
    selecionados,
    doFiltro: publico.length,
    excluidosPorRecente: publico.length - semRecentes.length,
    cortadosPeloLimite: semRecentes.length - selecionados.length,
  };
}

/** Público final da campanha: filtro já resolvido + regras. */
export async function aplicarRegrasDeEnvio(
  admin: SupabaseClient,
  organizationId: string,
  publico: AudienceMember[],
  regras: RegrasDeEnvio,
  agora: Date = new Date(),
): Promise<PublicoRecortado> {
  const dias = regras.excluirQuemRecebeuDias ?? null;
  const jaReceberam = dias
    ? await contatosQueReceberamCampanha(admin, organizationId, new Date(agora.getTime() - dias * 86_400_000))
    : new Set<string>();
  return recortarPublico(publico, jaReceberam, regras.limite);
}
