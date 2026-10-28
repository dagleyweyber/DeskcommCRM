"use client";
import { useQuery } from "@tanstack/react-query";

import { Card } from "@/components/ui/card";
import { apiClient } from "@/lib/api/client";
import { ROTULO_DO_EVENTO_META_CAPI, type EventoMetaCapiDeEtapa } from "@/lib/meta-ads/stage-event-vocabulary";
import type { ResumoDoEvento } from "@/lib/meta-ads/resumo-de-envios";

/**
 * "As conversões estão chegando na Meta?" — aceitas e recusadas por evento, com o
 * motivo e o que fazer.
 *
 * Existe porque a resposta era invisível: a conexão aparecia "Conectado" enquanto a
 * maioria das vendas era recusada (B'laser Caruaru: 25 de 29 vendas fora da otimização
 * em 30 dias). Sem este painel, quem configura a campanha não tem como saber que a
 * Meta não está aprendendo com as vendas.
 */
interface Resposta {
  dias: number;
  eventos: ResumoDoEvento[];
}

function rotuloDoEvento(evento: string): string {
  if (evento === "Purchase") return "Venda (Purchase)";
  return ROTULO_DO_EVENTO_META_CAPI[evento as EventoMetaCapiDeEtapa] ?? evento;
}

export function PainelDeEnvios() {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["meta-ads-sends"],
    staleTime: 60_000,
    queryFn: async () => {
      const res = await apiClient.get<{ data: Resposta }>("/api/v1/integrations/meta-ads/sends");
      if (res && typeof res === "object" && "data" in res) return (res as { data: Resposta }).data;
      return res as unknown as Resposta;
    },
  });

  return (
    <Card className="flex flex-col gap-4 p-6" data-testid="painel-de-envios-meta">
      <div>
        <h2 className="font-medium">Conversões enviadas à Meta</h2>
        <p className="text-sm text-muted-foreground">
          Últimos {data?.dias ?? 30} dias, contando cada lead uma vez. Conversão recusada não ajuda a Meta a otimizar as
          campanhas.
        </p>
      </div>

      {isLoading && <p className="text-sm text-muted-foreground">Carregando…</p>}
      {isError && <p className="text-sm text-destructive">Não foi possível carregar os envios.</p>}
      {data && data.eventos.length === 0 && (
        <p className="text-sm text-muted-foreground">Nenhuma conversão enviada no período.</p>
      )}

      {data?.eventos.map((e) => (
        <div key={e.evento} className="w-full border-t border-border pt-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="text-sm font-medium">{rotuloDoEvento(e.evento)}</p>
            <p className="text-sm tabular-nums">
              <span className="text-success-fg">{e.aceitos} aceitos</span>
              <span className="text-muted-foreground"> · </span>
              <span className={e.recusados > 0 ? "text-destructive" : "text-muted-foreground"}>
                {e.recusados} recusados
              </span>
            </p>
          </div>
          {e.motivos.length > 0 && (
            <ul className="mt-2 space-y-2">
              {e.motivos.map((m) => (
                <li key={m.motivo} className="rounded-md bg-muted/50 px-3 py-2 text-xs">
                  <p className="text-text">
                    <span className="font-medium tabular-nums">{m.leads} lead(s):</span> {m.motivo}
                  </p>
                  {m.oQueFazer && <p className="mt-1 text-muted-foreground">O que fazer: {m.oQueFazer}</p>}
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </Card>
  );
}
