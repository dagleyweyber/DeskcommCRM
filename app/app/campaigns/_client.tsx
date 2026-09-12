"use client";
import { useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  useCampaigns,
  useCancelCampaign,
  usePauseCampaign,
  useStartCampaign,
  type CampaignSummary,
} from "@/hooks/campaigns/useCampaigns";
import { AutomacoesClient } from "./_components/AutomacoesClient";
import { NovaCampanhaForm } from "./_components/NovaCampanhaForm";

const COR_DO_STATUS: Record<CampaignSummary["status"], "default" | "secondary" | "destructive" | "outline"> = {
  draft: "outline",
  queued: "secondary",
  running: "default",
  paused: "secondary",
  completed: "default",
  cancelled: "destructive",
};

const ROTULO_DO_STATUS: Record<CampaignSummary["status"], string> = {
  draft: "Rascunho",
  queued: "Na fila",
  running: "Enviando",
  paused: "Pausada",
  completed: "Concluída",
  cancelled: "Cancelada",
};

function BarraDeProgresso({ campanha }: { campanha: CampaignSummary }) {
  if (campanha.total_recipients === 0) return null;
  const pct = Math.round(((campanha.sent_count + campanha.failed_count) / campanha.total_recipients) * 100);
  return (
    <div className="flex flex-col gap-1">
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div className="h-full bg-primary transition-all" style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs text-muted-foreground">
        {campanha.sent_count} enviada(s)
        {campanha.failed_count > 0 ? `, ${campanha.failed_count} falhou/falharam` : ""} de{" "}
        {campanha.total_recipients}
      </span>
    </div>
  );
}

function AcoesDaCampanha({ campanha }: { campanha: CampaignSummary }) {
  const start = useStartCampaign();
  const pause = usePauseCampaign();
  const cancel = useCancelCampaign();

  const acaoComToast = (
    mutation: ReturnType<typeof useStartCampaign>,
    mensagem: string,
  ) => () =>
    mutation.mutate(campanha.id, { onSuccess: () => toast.success(mensagem) });

  if (campanha.status === "draft" || campanha.status === "paused") {
    return (
      <div className="flex gap-2">
        <Button size="sm" onClick={acaoComToast(start, "Campanha na fila — o disparo começa no próximo minuto.")} disabled={start.isPending}>
          {campanha.status === "paused" ? "Retomar" : "Iniciar disparo"}
        </Button>
        <Button size="sm" variant="outline" onClick={acaoComToast(cancel, "Campanha cancelada.")} disabled={cancel.isPending}>
          Cancelar
        </Button>
      </div>
    );
  }
  if (campanha.status === "queued" || campanha.status === "running") {
    return (
      <div className="flex gap-2">
        <Button size="sm" variant="outline" onClick={acaoComToast(pause, "Campanha pausada.")} disabled={pause.isPending}>
          Pausar
        </Button>
        <Button size="sm" variant="outline" onClick={acaoComToast(cancel, "Campanha cancelada.")} disabled={cancel.isPending}>
          Cancelar
        </Button>
      </div>
    );
  }
  return null;
}

function DisparosTab() {
  const { data, isPending } = useCampaigns();
  const [criando, setCriando] = useState(false);
  const campanhas = data?.data.campaigns ?? [];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-end">
        <Button type="button" variant={criando ? "outline" : "default"} onClick={() => setCriando((v) => !v)}>
          {criando ? "Cancelar" : "Nova campanha"}
        </Button>
      </div>

      {criando && <NovaCampanhaForm onCriada={() => setCriando(false)} />}

      {isPending ? (
        <p className="text-sm text-muted-foreground">Carregando…</p>
      ) : campanhas.length === 0 ? (
        <Card className="p-6">
          <h2 className="font-medium">Nenhuma campanha ainda</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Clique em <strong>Nova campanha</strong> pra escolher um modelo aprovado e um público.
          </p>
        </Card>
      ) : (
        <div className="flex flex-col gap-3">
          {campanhas.map((c) => (
            <Card key={c.id} className="p-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{c.name}</span>
                <Badge variant={COR_DO_STATUS[c.status]}>{ROTULO_DO_STATUS[c.status]}</Badge>
                <span className="text-xs text-muted-foreground">
                  {c.template_name} ({c.template_language})
                </span>
                <div className="ml-auto">
                  <AcoesDaCampanha campanha={c} />
                </div>
              </div>
              <div className="mt-3">
                <BarraDeProgresso campanha={c} />
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Duas abas dentro do MESMO menu "Campanhas" — pedido explícito do dono da
 * agência ao encomendar a 1ª automação recorrente ("no menu de
 * campanhas"), em vez de um item de navegação novo. `Automações` é
 * conceitualmente diferente de `Disparos` (recorrente vs. uma vez só),
 * mas os dois vivem da mesma infraestrutura de canal/template/variável —
 * ficar juntos é onde o operador já olha pra "mandar mensagem em massa".
 */
export function CampaignsClient() {
  return (
    <Tabs defaultValue="disparos">
      <TabsList>
        <TabsTrigger value="disparos">Disparos</TabsTrigger>
        <TabsTrigger value="automacoes">Automações</TabsTrigger>
      </TabsList>
      <TabsContent value="disparos" className="mt-4">
        <DisparosTab />
      </TabsContent>
      <TabsContent value="automacoes" className="mt-4">
        <AutomacoesClient />
      </TabsContent>
    </Tabs>
  );
}
