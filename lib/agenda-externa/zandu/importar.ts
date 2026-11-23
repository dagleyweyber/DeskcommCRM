/**
 * Importação inicial do Zandu: traz para a Agenda o que JÁ estava marcado antes da conexão.
 *
 * O webhook só avisa o que muda depois de assinado — sem isto, a agenda da clínica entra
 * pela metade (só o que for criado ou mexido dali em diante).
 *
 * A API do Zandu não lista agendamentos por período (o endpoint exige telefone e tem cota
 * diária). O caminho que cabe na cota:
 *   1. relatório "Pessoas com agendamento" no período → telefones (uma consulta);
 *   2. agendamentos de cada telefone no período → os agendamentos com código, agenda e
 *      serviços (uma consulta por pessoa, UMA vez — não é polling);
 *   3. mesmo motor do aviso: completa nome/serviço/agenda e aplica com `aplicarItens`.
 *
 * Idempotente: rodar de novo atualiza os mesmos agendamentos (casam pelo código), não duplica.
 * Silencioso como a 1ª leitura do Belle: não move funil por agendamento antigo.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { completarPeloZandu } from "../avisos";
import { aplicarItens, fusoDaClinica, type Contagem, type Integracao } from "../sincronizar";
import type { ClienteZandu } from "./api";
import { traduzirAvisoDoZandu } from "./traduzir";

export const DIAS_PARA_TRAS = 7;
export const DIAS_PARA_FRENTE = 120;

export interface ResultadoDaImportacao {
  pessoas: number;
  agendamentos: number;
  contagem: Contagem;
  /** Parou antes do fim (cota do Zandu): rodar de novo amanhã completa. */
  incompleto: boolean;
}

const dia = (d: Date) => d.toISOString().slice(0, 10);

export async function importarAgendaDoZandu(
  admin: SupabaseClient,
  integ: Integracao,
  cliente: ClienteZandu,
  opcoes: { agora?: Date } = {},
): Promise<ResultadoDaImportacao> {
  const agora = opcoes.agora ?? new Date();
  const de = new Date(agora.getTime() - DIAS_PARA_TRAS * 86_400_000);
  const ate = new Date(agora.getTime() + DIAS_PARA_FRENTE * 86_400_000);
  const contagem: Contagem = {
    criados: 0,
    atualizados: 0,
    cancelados_por_remocao: 0,
    contatos_criados: 0,
    sem_telefone: 0,
    salas_criadas: 0,
    confirmacoes_devolvidas: 0,
    confirmacoes_recusadas: 0,
  };

  const telefones = await cliente.telefonesComAgendamento(dia(de), dia(ate));
  const porCodigo = new Map<string, Record<string, unknown>>();
  let incompleto = false;
  for (const fone of telefones) {
    try {
      for (const ag of await cliente.agendamentosDoTelefone(fone, de.toISOString(), ate.toISOString())) {
        const codigo = String(ag.appointmentId ?? "");
        if (codigo) porCodigo.set(codigo, ag);
      }
    } catch (err) {
      // Cota/limite: aplica o que já leu; o resto entra numa próxima importação ou pelos avisos.
      if (err instanceof Error && /limite/i.test(err.message)) {
        incompleto = true;
        break;
      }
      throw err;
    }
  }

  const aviso = traduzirAvisoDoZandu({ data: [...porCodigo.values()], event: {} });
  if (aviso.itens.length > 0) {
    await completarPeloZandu(admin, integ, aviso, agora, cliente);
    const timezone = await fusoDaClinica(admin, integ.organization_id);
    await aplicarItens(
      admin,
      integ,
      aviso.itens.map((i) => i.item),
      timezone,
      { silencioso: true, agora, contagem },
    );
  }
  return { pessoas: telefones.length, agendamentos: aviso.itens.length, contagem, incompleto };
}
