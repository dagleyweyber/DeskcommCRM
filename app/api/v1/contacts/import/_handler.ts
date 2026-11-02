/**
 * POST /api/v1/contacts/import — um LOTE (até 500 linhas) de uma importação por
 * planilha. A planilha é lida no navegador; aqui chegam linhas, nunca o arquivo
 * (parser de xlsx no servidor é superfície de ataque sem necessidade).
 *
 * O servidor não confia na prévia do navegador: refaz telefone, variantes do 9º
 * dígito, tags e e-mail com as MESMAS regras (`lib/contacts/importacao.ts`) e só
 * então chama `fn_importar_contatos`, com o cliente do usuário (RLS vale).
 *
 * Não cria lead e não emite evento por contato — ver a migration 0210.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { ApiError } from "@/lib/api/types";
import type { HandlerCtx } from "@/lib/api/handlers/types";
import { audit } from "@/lib/audit";
import { phoneLookupVariants } from "@/lib/channels/phone-variants";
import {
  LINHAS_POR_LOTE,
  MAX_TAGS,
  MAX_TAMANHO_TAG,
  normalizarTag,
  telefoneDaPlanilha,
} from "@/lib/contacts/importacao";

const tagSchema = z.string().transform(normalizarTag).pipe(z.string().min(1).max(MAX_TAMANHO_TAG));

export const importLoteSchema = z.object({
  /** Gerado pelo navegador; agrupa os lotes de uma mesma planilha no audit e no contato. */
  import_id: z.string().uuid(),
  file_name: z.string().trim().max(200).default(""),
  tags: z.array(tagSchema).max(MAX_TAGS).default([]),
  /** Declaração do operador de que a base autorizou receber mensagens (opt-in). */
  consentimento_marketing: z.boolean(),
  linhas: z
    .array(
      z.object({
        linha: z.number().int().min(2),
        telefone: z.string().min(1).max(40),
        nome: z.string().trim().max(200).nullable().optional(),
        email: z.string().trim().toLowerCase().email().max(254).nullable().optional().catch(null),
        tags: z.array(tagSchema).max(MAX_TAGS).default([]),
      }),
    )
    .min(1)
    .max(LINHAS_POR_LOTE),
});
export type ImportLote = z.infer<typeof importLoteSchema>;

export type ResultadoDaLinha = "criado" | "atualizado" | "ignorado";

export interface ResultadoDoLote {
  criados: number;
  atualizados: number;
  ignorados: number;
  /** Só o que precisa de atenção: ignorados e atualizados com aviso (ex.: bloqueado). */
  avisos: { linha: number; resultado: ResultadoDaLinha; motivo: string }[];
}

interface LinhaDoBanco {
  linha: number;
  resultado: ResultadoDaLinha;
  motivo: string | null;
  contact_id: string | null;
}

export async function importarLoteHandler(
  supabase: SupabaseClient,
  ctx: HandlerCtx & { actor: { type: "user"; id: string } },
  input: ImportLote,
): Promise<ResultadoDoLote> {
  const avisos: ResultadoDoLote["avisos"] = [];
  const paraBanco: Array<{ linha: number; telefone: string; variantes: string[]; nome: string | null; email: string | null; tags: string[] }> = [];

  for (const l of input.linhas) {
    const tel = telefoneDaPlanilha(l.telefone);
    if ("motivo" in tel) {
      avisos.push({ linha: l.linha, resultado: "ignorado", motivo: tel.motivo });
      continue;
    }
    paraBanco.push({
      linha: l.linha,
      telefone: tel.e164,
      variantes: phoneLookupVariants(tel.e164),
      nome: l.nome || null,
      email: l.email ?? null,
      tags: [...new Set(l.tags)],
    });
  }

  let linhas: LinhaDoBanco[] = [];
  if (paraBanco.length > 0) {
    const { data, error } = await supabase.rpc("fn_importar_contatos", {
      p_org: ctx.organization_id,
      p_linhas: paraBanco,
      p_tags: [...new Set(input.tags)],
      p_consentir: input.consentimento_marketing,
      p_origem: { import_id: input.import_id, file_name: input.file_name },
    });
    if (error) {
      throw new ApiError(500, "internal_error", undefined, ctx.requestId, error.message);
    }
    linhas = (data ?? []) as LinhaDoBanco[];
  }

  const resultado: ResultadoDoLote = { criados: 0, atualizados: 0, ignorados: avisos.length, avisos };
  for (const l of linhas) {
    if (l.resultado === "criado") resultado.criados += 1;
    else if (l.resultado === "atualizado") resultado.atualizados += 1;
    else resultado.ignorados += 1;
    if (l.motivo) avisos.push({ linha: l.linha, resultado: l.resultado, motivo: l.motivo });
  }
  avisos.sort((a, b) => a.linha - b.linha);

  await audit({
    action: "contacts.imported",
    actorUserId: ctx.actor.id,
    organizationId: ctx.organization_id,
    resourceType: "contact_import",
    resourceId: input.import_id,
    requestId: ctx.requestId,
    metadata: {
      actor_type: "user",
      file_name: input.file_name,
      tags: input.tags,
      consentimento_marketing: input.consentimento_marketing,
      linhas: input.linhas.length,
      criados: resultado.criados,
      atualizados: resultado.atualizados,
      ignorados: resultado.ignorados,
    },
  });

  return resultado;
}
