"use client";
import { useState } from "react";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
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
import { emEspera } from "@/lib/campaigns/blocos";
import { MOTIVOS_DISPENSAVEIS, TEXTO_DO_MOTIVO } from "@/lib/campaigns/motivos-de-pausa";
import { AutomacoesClient } from "./_components/AutomacoesClient";
import { NovaCampanhaForm } from "./_components/NovaCampanhaForm";
import { NumerosDaApi } from "./_components/NumerosDaApi";
import { PainelDaCampanha } from "./_components/PainelDaCampanha";

function hora(iso: string): string {
  return new Date(iso).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

/** Por que a campanha parou e o que fazer — no próprio cartão, não escondido na Central. */
function AvisoDaPausa({ campanha }: { campanha: CampaignSummary }) {
  if (campanha.status !== "paused" || !campanha.pausa_motivo) return null;
  const texto = TEXTO_DO_MOTIVO[campanha.pausa_motivo];
  const manual = campanha.pausa_motivo === "manual";
  return (
    <div
      className={`mt-3 rounded-md border px-3 py-2 text-sm ${
        manual ? "border-border bg-muted/40" : "border-red-300 bg-red-50 text-red-900 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200"
      }`}
      data-testid="campanha-aviso-pausa"
    >
      <p className="font-medium">
        {manual ? texto.titulo : `Parada automática: ${texto.titulo.toLowerCase()}`}
        {campanha.pausada_em ? ` · ${new Date(campanha.pausada_em).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })}` : ""}
      </p>
      {campanha.pausa_detalhe && <p className="mt-0.5">{campanha.pausa_detalhe}</p>}
      {!manual && <p className="mt-0.5 text-xs opacity-90">{texto.acao}</p>}
    </div>
  );
}

/** Espera programada: em que bloco está e quando volta. */
function SituacaoDosBlocos({ campanha }: { campanha: CampaignSummary }) {
  if (!campanha.bloco_tamanho || !campanha.bloco_espera_minutos) return null;
  const regra = `Blocos de ${campanha.bloco_tamanho.toLocaleString("pt-BR")} com ${campanha.bloco_espera_minutos} min de espera`;
  const esperando = campanha.status === "running" && emEspera(campanha.proximo_bloco_em, new Date());
  return (
    <p className="mt-1 text-xs text-muted-foreground" data-testid="campanha-blocos-situacao">
      {regra}
      {esperando && campanha.proximo_bloco_em ? ` · em espera, o próximo bloco começa às ${hora(campanha.proximo_bloco_em)}` : ""}
    </p>
  );
}

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
        {/* Só aparece em campanha com botão de link da campanha (migration 0216). */}
        {campanha.cliques !== null && campanha.cliques !== undefined ? ` · ${campanha.cliques} clique(s) no botão` : ""}
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

  const [confirmando, setConfirmando] = useState(false);
  const iniciar = acaoComToast(start, "Campanha na fila — o disparo começa no próximo minuto.");

  if (campanha.status === "draft" || campanha.status === "paused") {
    // Parou sozinha? Retomar pede confirmação mostrando o motivo: quem retoma precisa saber o risco.
    const motivo = campanha.status === "paused" ? campanha.pausa_motivo : null;
    const pedeConfirmacao = Boolean(motivo && motivo !== "manual");
    const assumeRisco = Boolean(motivo && MOTIVOS_DISPENSAVEIS.includes(motivo));
    return (
      <div className="flex gap-2">
        <Button
          size="sm"
          onClick={pedeConfirmacao ? () => setConfirmando(true) : iniciar}
          disabled={start.isPending}
        >
          {campanha.status === "paused" ? "Retomar" : "Iniciar disparo"}
        </Button>
        {motivo && pedeConfirmacao && (
          <AlertDialog open={confirmando} onOpenChange={setConfirmando}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Retomar a campanha “{campanha.name}”?</AlertDialogTitle>
                <AlertDialogDescription asChild>
                  <div className="flex flex-col gap-2 text-sm">
                    <p>
                      Ela parou sozinha: <strong>{TEXTO_DO_MOTIVO[motivo].titulo.toLowerCase()}</strong>.
                    </p>
                    {campanha.pausa_detalhe && <p>{campanha.pausa_detalhe}</p>}
                    <p>{TEXTO_DO_MOTIVO[motivo].acao}</p>
                    {assumeRisco && (
                      <p className="font-medium">
                        Ao retomar, a campanha não para de novo por este mesmo motivo.
                      </p>
                    )}
                  </div>
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Deixar pausada</AlertDialogCancel>
                <AlertDialogAction onClick={iniciar} data-testid="campanha-retomar-confirmar">
                  Retomar mesmo assim
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}
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

function CartaoDaCampanha({ c }: { c: CampaignSummary }) {
  const [vendoResultado, setVendoResultado] = useState(false);
  const andando = c.status === "running" || c.status === "queued";
  return (
    <Card className="p-4" data-testid="campanha-cartao">
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
      <AvisoDaPausa campanha={c} />
      <div className="mt-3">
        <BarraDeProgresso campanha={c} />
        <SituacaoDosBlocos campanha={c} />
      </div>
      {c.status !== "draft" && (
        <div className="mt-2">
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2 text-xs"
            onClick={() => setVendoResultado((v) => !v)}
            data-testid="campanha-ver-resultado"
          >
            {vendoResultado ? "Esconder resultados" : "Ver resultados"}
          </Button>
          {vendoResultado && (
            <div className="mt-2">
              <PainelDaCampanha campanhaId={c.id} andando={andando} />
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

function DisparosTab() {
  const { data, isPending } = useCampaigns();
  const [criando, setCriando] = useState(false);
  const campanhas = data?.data.campaigns ?? [];

  return (
    <div className="flex flex-col gap-4">
      <NumerosDaApi />
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
            <CartaoDaCampanha key={c.id} c={c} />
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
