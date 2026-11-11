/**
 * Apagar um modelo do canal oficial — pedido do dono do produto (B'Laser
 * Parnamirim): modelos que não serão mais usados poluem a lista.
 *
 * Automação e campanha apontam para o modelo por NOME (`template_name`), sem FK.
 * Apagar um modelo em uso faria a confirmação de agendamento (ou a campanha)
 * falhar só na hora do envio, horas depois e sem ninguém olhando. Por isso o
 * apagar é BARRADO enquanto houver uso — a pessoa vê quais são e decide.
 *
 * A Meta apaga por nome: todos os idiomas daquele nome somem juntos. O uso é
 * conferido pelo nome, sem olhar o idioma, pelo mesmo motivo.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export interface UsoDoModelo {
  tipo: "automacao" | "campanha";
  id: string;
  nome: string;
  status: string;
}

/** Campanha encerrada já não envia — o modelo pode sair. As demais ainda podem disparar. */
const CAMPANHA_ENCERRADA = ["completed", "cancelled"];

/**
 * Quem ainda depende do modelo. Automação conta em QUALQUER status: pausada ou
 * rascunho volta a enviar com um clique, e aí falharia.
 */
export async function usosDoModelo(
  admin: SupabaseClient,
  organizationId: string,
  nome: string,
): Promise<UsoDoModelo[]> {
  const [automacoes, campanhas] = await Promise.all([
    admin
      .from("whatsapp_template_automations")
      .select("id, name, status")
      .eq("organization_id", organizationId)
      .eq("template_name", nome)
      // Excluída (0222) nunca mais envia — não pode segurar o modelo.
      .is("archived_at", null),
    admin
      .from("whatsapp_campaigns")
      .select("id, name, status")
      .eq("organization_id", organizationId)
      .eq("template_name", nome)
      .not("status", "in", `(${CAMPANHA_ENCERRADA.join(",")})`),
  ]);
  if (automacoes.error) throw new Error(`usos_do_modelo: ${automacoes.error.message}`);
  if (campanhas.error) throw new Error(`usos_do_modelo: ${campanhas.error.message}`);

  type Linha = { id: string; name: string | null; status: string };
  return [
    ...((automacoes.data ?? []) as Linha[]).map((a) => ({
      tipo: "automacao" as const,
      id: a.id,
      nome: a.name ?? "(sem nome)",
      status: a.status,
    })),
    ...((campanhas.data ?? []) as Linha[]).map((c) => ({
      tipo: "campanha" as const,
      id: c.id,
      nome: c.name ?? "(sem nome)",
      status: c.status,
    })),
  ];
}

/** Frase para a tela: "Em uso por: automação "X", campanha "Y"." */
export function descreverUsos(usos: UsoDoModelo[]): string {
  const itens = usos.map((u) => `${u.tipo === "automacao" ? "automação" : "campanha"} "${u.nome}"`);
  return `Em uso por: ${itens.join(", ")}. Troque o modelo ou exclua ${usos.length > 1 ? "esses itens" : "esse item"} antes de apagar.`;
}
