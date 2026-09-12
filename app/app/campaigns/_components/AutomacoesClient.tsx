"use client";
import { useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  useActivateAutomation,
  useAutomations,
  usePauseAutomation,
  type AutomationSummary,
} from "@/hooks/campaigns/useAutomations";
import { NovaAutomacaoForm } from "./NovaAutomacaoForm";

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

export function AutomacoesClient() {
  const { data, isPending } = useAutomations();
  const [criando, setCriando] = useState(false);
  const automacoes = data?.data.automations ?? [];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-end">
        <Button type="button" variant={criando ? "outline" : "default"} onClick={() => setCriando((v) => !v)}>
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
          {automacoes.map((a) => (
            <Card key={a.id} className="p-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{a.name}</span>
                <Badge variant={COR_DO_STATUS[a.status]}>{ROTULO_DO_STATUS[a.status]}</Badge>
                <span className="text-xs text-muted-foreground">
                  {ROTULO_DO_GATILHO[a.trigger_kind] ?? a.trigger_kind} · {a.template_name} (
                  {a.template_language})
                </span>
                <div className="ml-auto">
                  <AcoesDaAutomacao automacao={a} />
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
