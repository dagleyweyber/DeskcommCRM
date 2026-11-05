"use client";
import { useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  useActivateAutomation,
  useAutomation,
  useAutomations,
  usePauseAutomation,
  type AutomationSummary,
} from "@/hooks/campaigns/useAutomations";
import { AutomacaoForm, NovaAutomacaoForm, rotuloDoMomento } from "./NovaAutomacaoForm";

const COR_DO_STATUS: Record<AutomationSummary["status"], "default" | "secondary" | "outline"> = {
  draft: "outline",
  active: "default",
  paused: "secondary",
};

const ROTULO_DO_STATUS: Record<AutomationSummary["status"], string> = {
  draft: "Rascunho",
  active: "Ativa",
  paused: "Pausada",
};

const ROTULO_DO_GATILHO: Record<string, string> = {
  appointment_reminder: "Confirmação de agendamento",
};

function AcoesDaAutomacao({ automacao }: { automacao: AutomationSummary }) {
  const activate = useActivateAutomation();
  const pause = usePauseAutomation();

  if (automacao.status === "draft" || automacao.status === "paused") {
    return (
      <Button
        size="sm"
        onClick={() =>
          activate.mutate(automacao.id, {
            onSuccess: () => toast.success("Automação ativada — roda sozinha a partir de agora."),
          })
        }
        disabled={activate.isPending}
      >
        Ativar
      </Button>
    );
  }
  return (
    <Button
      size="sm"
      variant="outline"
      onClick={() => pause.mutate(automacao.id, { onSuccess: () => toast.success("Automação pausada.") })}
      disabled={pause.isPending}
    >
      Pausar
    </Button>
  );
}

/**
 * Carrega a configuração COMPLETA (a lista não traz o mapeamento das variáveis) e abre o
 * formulário já preenchido. O formulário só monta depois do carregamento: ele lê o estado
 * inicial uma vez, então montá-lo antes mostraria campos vazios e salvaria por cima.
 */
function EditarAutomacao({ id, onFechar }: { id: string; onFechar: () => void }) {
  const { data, isPending, isError } = useAutomation(id);
  const automacao = data?.data.automation;

  if (isPending) return <p className="text-sm text-muted-foreground">Carregando automação…</p>;
  if (isError || !automacao) {
    return (
      <Card className="flex items-center justify-between gap-2 p-4">
        <p className="text-sm text-destructive">Não consegui abrir esta automação para editar.</p>
        <Button type="button" size="sm" variant="outline" onClick={onFechar}>
          Fechar
        </Button>
      </Card>
    );
  }
  return <AutomacaoForm automacao={automacao} onConcluido={onFechar} onCancelar={onFechar} />;
}

export function AutomacoesClient() {
  const { data, isPending } = useAutomations();
  const [criando, setCriando] = useState(false);
  const [editandoId, setEditandoId] = useState<string | null>(null);
  const automacoes = data?.data.automations ?? [];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-end">
        <Button
          type="button"
          variant={criando ? "outline" : "default"}
          onClick={() => {
            setEditandoId(null);
            setCriando((v) => !v);
          }}
        >
          {criando ? "Cancelar" : "Nova automação"}
        </Button>
      </div>

      {criando && <NovaAutomacaoForm onCriada={() => setCriando(false)} />}

      {isPending ? (
        <p className="text-sm text-muted-foreground">Carregando…</p>
      ) : automacoes.length === 0 ? (
        <Card className="p-6">
          <h2 className="font-medium">Nenhuma automação ainda</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Clique em <strong>Nova automação</strong> pra configurar o lembrete de agendamento — depois de
            ativar, roda sozinha pra todo lead com uma visita marcada.
          </p>
        </Card>
      ) : (
        <div className="flex flex-col gap-3">
          {automacoes.map((a) =>
            editandoId === a.id ? (
              <EditarAutomacao key={a.id} id={a.id} onFechar={() => setEditandoId(null)} />
            ) : (
            <Card key={a.id} className="p-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{a.name}</span>
                <Badge variant={COR_DO_STATUS[a.status]}>{ROTULO_DO_STATUS[a.status]}</Badge>
                <span className="text-xs text-muted-foreground">
                  {ROTULO_DO_GATILHO[a.trigger_kind] ?? a.trigger_kind} · {a.template_name} (
                  {a.template_language})
                </span>
                <Badge variant="outline" data-testid="automacao-servico">
                  {a.event_type?.name ?? "Todos os serviços"}
                </Badge>
                <Badge variant="outline">{rotuloDoMomento(a.timing_kind, a.timing_value)}</Badge>
                {(a.confirm_button_text || a.decline_button_text) && (
                  <Badge variant="outline" title="A resposta do cliente atualiza o status na Agenda">
                    Confirma pela resposta
                  </Badge>
                )}
                <div className="ml-auto flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setCriando(false);
                      setEditandoId(a.id);
                    }}
                    aria-label={`Editar ${a.name}`}
                  >
                    Editar
                  </Button>
                  <AcoesDaAutomacao automacao={a} />
                </div>
              </div>
            </Card>
            ),
          )}
        </div>
      )}
    </div>
  );
}
