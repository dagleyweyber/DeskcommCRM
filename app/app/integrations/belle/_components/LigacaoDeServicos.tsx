"use client";
import { useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { apiClient } from "@/lib/api/client";
import { chaveDoNome } from "@/lib/agenda-externa/belle/traduzir";

interface Tipo {
  external_key: string;
  external_label: string;
  event_type_id: string | null;
  sugestao: string | null;
}

interface Servico {
  id: string;
  name: string;
  is_active: boolean;
}

const CHAVE = ["integrations", "belle", "servicos"] as const;
const ROTA = "/api/v1/integrations/belle/servicos";
const SEM_LIGACAO = "__sem__";
const CRIAR = "__criar__";

/** "Depilação a Laser" → "depilacao-a-laser" (slug que a API de serviços exige). */
function slugDe(nome: string): string {
  return chaveDoNome(nome).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "servico";
}

/**
 * Tipo de serviço do Belle → serviço da Agenda. É o serviço que decide qual
 * automação (e qual modelo de WhatsApp) a paciente recebe. Tipo novo que surge
 * no Belle aparece aqui sozinho, destacado até ser ligado.
 */
export function LigacaoDeServicos({ canWrite }: { canWrite: boolean }) {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: CHAVE,
    queryFn: async () => (await apiClient.get<{ data: { tipos: Tipo[]; servicos: Servico[] } }>(ROTA)).data,
    refetchInterval: 60_000,
  });
  const [criandoPara, setCriandoPara] = useState<Tipo | null>(null);
  const [nomeNovo, setNomeNovo] = useState("");

  const ligar = useMutation({
    mutationFn: async (args: { external_key: string; event_type_id: string | null }) =>
      (await apiClient.patch<{ data: { agendamentos_corrigidos: number } }>(ROTA, args)).data,
    onError: showApiError,
    onSuccess: (r, args) => {
      toast.success(
        args.event_type_id
          ? `Ligado. ${r.agendamentos_corrigidos} agendamento(s) do Belle já usam este serviço.`
          : "Ligação removida.",
      );
      void qc.invalidateQueries({ queryKey: CHAVE });
    },
  });

  const criarServico = useMutation({
    mutationFn: async (args: { nome: string; tipo: Tipo }) => {
      const criado = await apiClient.post<{ data: { id: string } }>("/api/v1/agenda/tipos", {
        name: args.nome,
        slug: slugDe(args.nome),
      });
      return { id: criado.data.id, tipo: args.tipo };
    },
    onError: showApiError,
    onSuccess: ({ id, tipo }) => {
      setCriandoPara(null);
      setNomeNovo("");
      ligar.mutate({ external_key: tipo.external_key, event_type_id: id });
    },
  });

  if (!data) return null;
  const { tipos, servicos } = data;
  const nomeDo = (id: string | null) => servicos.find((s) => s.id === id)?.name ?? null;
  const faltam = tipos.filter((t) => !t.event_type_id).length;

  return (
    <Card className="flex flex-col gap-4 p-6">
      <div>
        <h2 className="font-medium">Serviços do Belle → serviços da Agenda</h2>
        <p className="text-sm text-muted-foreground">
          Ligue cada tipo de serviço do Belle a um serviço da Agenda. É o serviço que decide qual{" "}
          <Link href="/app/agenda" className="underline">
            automação de confirmação
          </Link>{" "}
          (e qual modelo de WhatsApp) a paciente recebe — depilação com um, estética com outro. Tipo novo que aparecer
          no Belle entra nesta lista sozinho.
        </p>
      </div>

      {tipos.length === 0 ? (
        <p className="text-sm text-muted-foreground">Os tipos aparecem aqui depois da primeira sincronização.</p>
      ) : (
        <>
          {faltam > 0 && (
            <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
              {faltam === 1 ? "1 tipo ainda não está ligado" : `${faltam} tipos ainda não estão ligados`}: esses
              agendamentos só recebem a automação de &ldquo;todos os serviços&rdquo;, se ela estiver ativa.
            </p>
          )}
          <ul className="flex flex-col divide-y rounded-md border">
            {tipos.map((t) => {
              const sugestao = nomeDo(t.sugestao);
              return (
                <li key={t.external_key} className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <p className="font-medium">{t.external_label}</p>
                    {!t.event_type_id && (
                      <p className="text-xs text-amber-700 dark:text-amber-400">
                        Não ligado{sugestao ? ` — sugestão: ${sugestao}` : ""}
                      </p>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {canWrite && !t.event_type_id && t.sugestao && sugestao && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={ligar.isPending}
                        onClick={() => ligar.mutate({ external_key: t.external_key, event_type_id: t.sugestao })}
                      >
                        Ligar a {sugestao}
                      </Button>
                    )}
                    <Select
                      value={t.event_type_id ?? SEM_LIGACAO}
                      disabled={!canWrite || ligar.isPending}
                      onValueChange={(v) => {
                        if (v === CRIAR) {
                          setCriandoPara(t);
                          setNomeNovo(t.external_label);
                          return;
                        }
                        ligar.mutate({ external_key: t.external_key, event_type_id: v === SEM_LIGACAO ? null : v });
                      }}
                    >
                      <SelectTrigger className="w-full sm:w-64" aria-label={`Serviço da Agenda para ${t.external_label}`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={SEM_LIGACAO}>Não ligado</SelectItem>
                        {servicos
                          .filter((s) => s.is_active || s.id === t.event_type_id)
                          .map((s) => (
                            <SelectItem key={s.id} value={s.id}>
                              {s.name}
                            </SelectItem>
                          ))}
                        <SelectSeparator />
                        <SelectItem value={CRIAR}>+ Criar serviço novo…</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  {criandoPara?.external_key === t.external_key && (
                    <form
                      className="flex w-full flex-wrap items-center gap-2 sm:basis-full"
                      onSubmit={(e) => {
                        e.preventDefault();
                        if (nomeNovo.trim().length >= 2) criarServico.mutate({ nome: nomeNovo.trim(), tipo: t });
                      }}
                    >
                      <Input
                        autoFocus
                        className="max-w-xs"
                        aria-label="Nome do serviço novo"
                        value={nomeNovo}
                        onChange={(e) => setNomeNovo(e.target.value)}
                      />
                      <Button type="submit" size="sm" disabled={criarServico.isPending || nomeNovo.trim().length < 2}>
                        {criarServico.isPending ? "Criando…" : "Criar e ligar"}
                      </Button>
                      <Button type="button" size="sm" variant="ghost" onClick={() => setCriandoPara(null)}>
                        Cancelar
                      </Button>
                    </form>
                  )}
                </li>
              );
            })}
          </ul>
          <p className="text-xs text-muted-foreground">
            Ao ligar, os agendamentos do Belle já importados desse tipo também passam a usar o serviço. Agendamento com
            serviços de tipos diferentes segue o primeiro serviço — a paciente recebe uma mensagem só.
          </p>
        </>
      )}
    </Card>
  );
}
