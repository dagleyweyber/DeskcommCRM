/**
 * Avisos (webhooks) de agendamento do Uno e do Zandu → Agenda do CRM.
 *
 * ─── O ciclo ─────────────────────────────────────────────────────────────────
 *  1. A rota do webhook GRAVA o aviso em `calendar_integration_events` e só então
 *     processa (o Uno tenta uma vez só e espera 10 s: o que está gravado não se perde).
 *  2. Processar = traduzir e aplicar com o MESMO motor do Belle (`aplicarItens`):
 *     casa a paciente pelo celular, cria sala e tipo de serviço, não duplica,
 *     fecha o laço no funil e alimenta a confirmação automática.
 *  3. Falhou? O aviso fica pendente e o cron da agenda externa tenta de novo
 *     (até `MAX_TENTATIVAS`), sempre do mais antigo para o mais novo.
 *
 * ─── Regras ──────────────────────────────────────────────────────────────────
 *  - O sistema da clínica manda (igual ao Belle): o importado é só leitura no CRM.
 *  - Aviso velho não desfaz aviso novo: se um aviso MAIS NOVO do mesmo agendamento
 *    já foi aplicado, o velho é dado por superado e não é reaplicado.
 *  - Remoção chega como item `cancelled` ("Removido no Uno").
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";
import { decryptWebhookSecret } from "@/lib/webhooks/secrets";

import { tipoDoServico, type AvisoTraduzido } from "./aviso-comum";
import { aplicarItens, fusoDaClinica, type Contagem, type Integracao } from "./sincronizar";
import { traduzirAvisoDoUno } from "./uno/traduzir";
import { criarClienteZandu, type ClienteZandu } from "./zandu/api";
import { codigoSemDetalhe, nomeDoServico, traduzirAvisoDoZandu } from "./zandu/traduzir";

export const MAX_TENTATIVAS = 5;

const ZERO: Contagem = {
  criados: 0,
  atualizados: 0,
  cancelados_por_remocao: 0,
  contatos_criados: 0,
  sem_telefone: 0,
  salas_criadas: 0,
  confirmacoes_devolvidas: 0,
  confirmacoes_recusadas: 0,
};

export const COLUNAS_INTEGRACAO =
  "id, organization_id, provider, credential_encrypted, external_account_id, default_area_code, initial_sync_done_at, far_window_index";

export function traduzirAviso(provedor: Integracao["provider"], payload: unknown): AvisoTraduzido {
  if (provedor === "uno") return traduzirAvisoDoUno(payload);
  if (provedor === "zandu") return traduzirAvisoDoZandu(payload);
  return { evento: "", externalId: null, conta: null, itens: [], motivo: "este sistema não recebe aviso" };
}

export interface AvisoGravado {
  id: string;
  payload: unknown;
  received_at: string;
  attempts: number;
}

export interface ResultadoDoAviso {
  ok: boolean;
  aplicado: boolean;
  motivo: string | null;
  contagem: Contagem;
}

/**
 * Catálogo de serviços e nomes de agenda do Zandu, por conexão, guardados 1 h na
 * memória do processo: mudam pouco, e a API do Zandu tem limite por token.
 */
const CACHE_MS = 60 * 60_000;
const cacheDoZandu = new Map<string, { ate: number; servicos: Map<string, string>; agendas: Map<string, string> }>();

async function catalogoDoZandu(integracaoId: string, cliente: ClienteZandu, agora: Date) {
  const guardado = cacheDoZandu.get(integracaoId);
  if (guardado && guardado.ate > agora.getTime()) return guardado;
  const [servicos, agendas] = await Promise.all([cliente.servicos(), cliente.agendas()]);
  const novo = { ate: agora.getTime() + CACHE_MS, servicos, agendas };
  cacheDoZandu.set(integracaoId, novo);
  return novo;
}

/**
 * O aviso do Zandu traz só códigos: completa pela API o nome e o celular da pessoa, o
 * nome do serviço (catálogo) e o nome da agenda (vira a sala). Uma consulta de pessoa
 * por agendamento; catálogo e agendas do cache.
 */
export async function clienteDoZandu(admin: SupabaseClient, integ: Integracao): Promise<ClienteZandu> {
  const token = integ.credential_encrypted ? await decryptWebhookSecret(admin, integ.credential_encrypted) : null;
  if (!token) throw new Error("Token do Zandu indisponível (não foi possível decifrar).");
  return criarClienteZandu({ token });
}

/**
 * Aviso do Zandu sem `data` (o de confirmação): busca o agendamento completo pelo código
 * e devolve o corpo no formato do aviso de criação. Se o Zandu não acha mais o agendamento
 * (apagado), monta o mínimo com o que o `event` traz — basta para cancelar o que já existe.
 */
export async function completarCorpoDoZandu(payload: unknown, cliente: ClienteZandu): Promise<unknown> {
  const codigo = codigoSemDetalhe(payload);
  if (!codigo) return payload;
  const corpo = (payload ?? {}) as Record<string, unknown>;
  const evento = (corpo.event ?? {}) as Record<string, unknown>;
  const completo = await cliente.agendamento(codigo);
  const ag = completo ?? {
    appointmentId: codigo,
    start: evento.externalDate,
    personId: evento.personId,
    status: evento.lastEvent,
  };
  return { ...corpo, data: [ag] };
}

export async function completarPeloZandu(
  admin: SupabaseClient,
  integ: Integracao,
  aviso: AvisoTraduzido,
  agora: Date,
  clienteZandu?: ClienteZandu,
): Promise<void> {
  const cliente = clienteZandu ?? (await clienteDoZandu(admin, integ));
  const precisaCatalogo = aviso.itens.some((i) => (i.servicoIds?.length ?? 0) > 0 || (i.item.salaCodigo && !i.item.salaNome));
  const catalogo = precisaCatalogo ? await catalogoDoZandu(integ.id, cliente, agora) : null;
  const pessoas = new Map<string, Awaited<ReturnType<ClienteZandu["pessoa"]>>>();

  for (const { item, pessoaId, servicoIds } of aviso.itens) {
    if (catalogo && servicoIds?.length) {
      const nomes = servicoIds.map((id) => catalogo.servicos.get(id)).filter((n): n is string => Boolean(n)).map(nomeDoServico);
      if (nomes.length) {
        item.titulo = nomes.join(", ").slice(0, 300);
        item.tipo = tipoDoServico(nomes[0]!);
      }
    }
    if (catalogo && item.salaCodigo && !item.salaNome) item.salaNome = catalogo.agendas.get(item.salaCodigo)?.trim() ?? "";
    if (pessoaId && (!item.cliente.celular || !item.cliente.nome)) {
      if (!pessoas.has(pessoaId)) pessoas.set(pessoaId, await cliente.pessoa(pessoaId));
      const pessoa = pessoas.get(pessoaId);
      if (pessoa) {
        if (!item.cliente.celular) item.cliente.celular = pessoa.phone || pessoa.phone2 || "";
        if (!item.cliente.nome && pessoa.name) item.cliente.nome = pessoa.name;
      }
    }
  }
}

/** Processa um aviso já gravado. Nunca lança: o resultado (e a linha do aviso) dizem o que houve. */
export async function processarAviso(
  admin: SupabaseClient,
  integ: Integracao,
  gravado: AvisoGravado,
  opcoes: { agora?: Date; clienteZandu?: ClienteZandu } = {},
): Promise<ResultadoDoAviso> {
  const agora = opcoes.agora ?? new Date();
  const contagem: Contagem = { ...ZERO };
  const fechar = async (patch: Record<string, unknown>) => {
    await admin
      .from("calendar_integration_events")
      .update({ attempts: gravado.attempts + 1, ...patch })
      .eq("id", gravado.id)
      .eq("organization_id", integ.organization_id);
  };

  try {
    let payload = gravado.payload;
    let clienteZandu = opcoes.clienteZandu;
    if (integ.provider === "zandu" && codigoSemDetalhe(payload)) {
      clienteZandu ??= await clienteDoZandu(admin, integ);
      payload = await completarCorpoDoZandu(payload, clienteZandu);
    }
    const aviso = traduzirAviso(integ.provider, payload);
    if (aviso.itens.length === 0) {
      await fechar({ processed_at: agora.toISOString(), last_error: aviso.motivo });
      return { ok: true, aplicado: false, motivo: aviso.motivo, contagem };
    }

    // Aviso velho não desfaz aviso novo do mesmo agendamento (o aviso é gravado com o
    // código do 1º agendamento; é por ele que se compara).
    const { data: maisNovo } = await admin
      .from("calendar_integration_events")
      .select("id")
      .eq("organization_id", integ.organization_id)
      .eq("integration_id", integ.id)
      .eq("external_id", aviso.itens[0]!.item.externalId)
      .not("processed_at", "is", null)
      .is("last_error", null)
      .gt("received_at", gravado.received_at)
      .limit(1);
    if (maisNovo && maisNovo.length > 0) {
      const motivo = "superado por um aviso mais novo do mesmo agendamento";
      await fechar({ processed_at: agora.toISOString(), last_error: motivo });
      return { ok: true, aplicado: false, motivo, contagem };
    }

    if (integ.provider === "zandu") await completarPeloZandu(admin, integ, aviso, agora, clienteZandu);

    const timezone = await fusoDaClinica(admin, integ.organization_id);
    const itens = aviso.itens.map((i) => i.item);
    await aplicarItens(admin, integ, itens, timezone, { silencioso: false, agora, contagem });
    if (itens.every((i) => i.status === "cancelled" && i.statusExterno === "Removido")) {
      contagem.cancelados_por_remocao = contagem.atualizados;
    }

    await fechar({ processed_at: agora.toISOString(), last_error: null });
    const patch: Record<string, unknown> = {
      status: "healthy",
      last_error: null,
      last_sync_at: agora.toISOString(),
      last_sync_stats: contagem,
    };
    // A conta (Uno: `schema`) só é conhecida no 1º aviso: vira o nome da unidade na tela.
    // A do Zandu é um UUID (`companyId`) — não serve de nome, fica de fora.
    if (integ.provider === "uno" && aviso.conta && !integ.external_account_id) {
      patch.external_account_id = aviso.conta;
      integ.external_account_id = aviso.conta;
    }
    if (!integ.initial_sync_done_at) patch.initial_sync_done_at = agora.toISOString();
    await admin.from("calendar_integrations").update(patch).eq("id", integ.id).eq("organization_id", integ.organization_id);
    return { ok: true, aplicado: true, motivo: null, contagem };
  } catch (err) {
    const erro = err instanceof Error ? err.message : String(err);
    logger.error("[agenda-externa] aviso não processado", {
      organization_id: integ.organization_id,
      integration_id: integ.id,
      aviso_id: gravado.id,
      erro,
    });
    await fechar({ last_error: erro.slice(0, 500) });
    await admin
      .from("calendar_integrations")
      .update({ status: "error", last_error: "Um aviso não pôde ser processado; o CRM tenta de novo sozinho." })
      .eq("id", integ.id)
      .eq("organization_id", integ.organization_id);
    return { ok: false, aplicado: false, motivo: erro, contagem };
  }
}

/** Cron: reprocessa avisos pendentes (falharam ou ficaram no meio), do mais antigo ao mais novo. */
export async function reprocessarAvisosPendentes(
  admin: SupabaseClient,
  opcoes: { agora?: Date; limite?: number; orcamentoMs?: number } = {},
): Promise<{ processados: number; falharam: number }> {
  const agora = opcoes.agora ?? new Date();
  const inicio = Date.now();
  // 1 min de folga: não disputa com a rota do webhook o aviso que acabou de chegar.
  const antesDe = new Date(agora.getTime() - 60_000).toISOString();
  const { data } = await admin
    .from("calendar_integration_events")
    .select("id, organization_id, integration_id, payload, received_at, attempts")
    .is("processed_at", null)
    .lt("attempts", MAX_TENTATIVAS)
    .lt("received_at", antesDe)
    .order("received_at", { ascending: true })
    .limit(opcoes.limite ?? 100);

  const integracoes = new Map<string, Integracao | null>();
  let processados = 0;
  let falharam = 0;
  for (const linha of (data ?? []) as (AvisoGravado & { organization_id: string; integration_id: string })[]) {
    if (Date.now() - inicio > (opcoes.orcamentoMs ?? 30_000)) break;
    if (!integracoes.has(linha.integration_id)) {
      const { data: integ } = await admin
        .from("calendar_integrations")
        .select(COLUNAS_INTEGRACAO)
        .eq("id", linha.integration_id)
        .eq("organization_id", linha.organization_id)
        .maybeSingle();
      integracoes.set(linha.integration_id, (integ as Integracao | null) ?? null);
    }
    const integ = integracoes.get(linha.integration_id);
    if (!integ) continue;
    const r = await processarAviso(admin, integ, linha, { agora });
    if (r.ok) processados += 1;
    else falharam += 1;
  }
  return { processados, falharam };
}
