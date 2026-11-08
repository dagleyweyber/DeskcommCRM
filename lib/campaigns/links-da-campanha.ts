/**
 * Botão de link escolhido na campanha (migration 0216): o operador cola o
 * destino, a campanha manda um código curto no `{{1}}` de `<crm>/l/{{1}}`, e a
 * rota pública `app/l/[codigo]` redireciona.
 *
 * Dividido em dois passos porque a campanha só tem id depois de inserida:
 * `prepararLinks` valida e gera os códigos ANTES (o mapeamento gravado já sai
 * com o código), `gravarLinks` insere as linhas depois.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { slotsDeLinkDaCampanha } from "@/lib/channels/template-conteudo";
import type { VariableMapping } from "@/lib/messaging/variable-mapping";

const ALFABETO = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

/** 10 caracteres sem os ambíguos (0/O, 1/l/I): ~57 bits, não dá para adivinhar. */
export function gerarCodigoDoLink(): string {
  const bytes = new Uint8Array(10);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => ALFABETO[b % ALFABETO.length]).join("");
}

export interface LinkPreparado {
  slot: string;
  codigo: string;
  destino: string;
}

export type ResultadoDosLinks =
  | { ok: true; mapping: VariableMapping; links: LinkPreparado[] }
  | { ok: false; mensagem: string };

/** Troca o destino colado em cada botão de link da campanha por um código novo. */
export function prepararLinks(
  components: unknown,
  mapping: VariableMapping,
  gerar: () => string = gerarCodigoDoLink,
): ResultadoDosLinks {
  const slots = slotsDeLinkDaCampanha(components);
  const links: LinkPreparado[] = [];
  const novo: VariableMapping = { ...mapping };
  for (const slot of slots) {
    const fonte = mapping[slot];
    const destino = fonte?.kind === "fixed" ? fonte.value.trim() : "";
    let valido = false;
    try {
      const u = new URL(destino);
      valido = u.protocol === "https:" || u.protocol === "http:";
    } catch {
      valido = false;
    }
    if (!valido || destino.length > 2048) {
      return {
        ok: false,
        mensagem: "Cole para onde o botão leva, começando com https:// (pode ser o link do grupo do WhatsApp).",
      };
    }
    const codigo = gerar();
    links.push({ slot, codigo, destino });
    novo[slot] = { kind: "fixed", value: codigo };
  }
  return { ok: true, mapping: novo, links };
}

export async function gravarLinks(
  admin: SupabaseClient,
  organizationId: string,
  campaignId: string,
  links: LinkPreparado[],
): Promise<{ error: { message: string } | null }> {
  if (links.length === 0) return { error: null };
  const { error } = await admin.from("whatsapp_campaign_links").insert(
    links.map((l) => ({
      organization_id: organizationId,
      campaign_id: campaignId,
      codigo: l.codigo,
      destino: l.destino,
    })),
  );
  return { error };
}
