"use client";
import { useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { showApiError } from "@/components/feedback/ApiErrorToast";
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
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiClient } from "@/lib/api/client";
import { ApiError } from "@/lib/api/types";
import { CalendarCheck } from "@/lib/ui/icons";

export interface ConexaoBelle {
  id: string;
  credential_last4: string;
  external_account_id: string;
  external_account_name: string | null;
  default_area_code: string | null;
  status: "healthy" | "invalid" | "error";
  last_error: string | null;
  last_sync_at: string | null;
  last_sync_stats: Partial<Record<"criados" | "atualizados" | "cancelados_por_remocao" | "contatos_criados" | "sem_telefone" | "salas_criadas", number>>;
  initial_sync_done_at: string | null;
}

interface Unidade {
  codigo: string;
  nome: string;
}

const CHAVE = ["integrations", "belle"] as const;
const ROTA = "/api/v1/integrations/belle";

const STATUS: Record<ConexaoBelle["status"], { rotulo: string; classe: string }> = {
  healthy: { rotulo: "Conectado", classe: "text-emerald-600 dark:text-emerald-400" },
  invalid: { rotulo: "Token recusado pelo Belle", classe: "text-destructive" },
  error: { rotulo: "Falha na última sincronização", classe: "text-amber-600 dark:text-amber-400" },
};

function quando(iso: string | null): string {
  if (!iso) return "ainda não sincronizou";
  return new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export function BelleClient({ initialData, canWrite }: { initialData: ConexaoBelle | null; canWrite: boolean }) {
  const qc = useQueryClient();
  const { data: conexao } = useQuery({
    queryKey: CHAVE,
    queryFn: async () => (await apiClient.get<{ data: ConexaoBelle | null }>(ROTA)).data,
    initialData,
    // A 1ª importação acontece em várias rodadas do scheduler: a tela acompanha sozinha.
    refetchInterval: 60_000,
  });

  const [token, setToken] = useState("");
  const [unidades, setUnidades] = useState<Unidade[] | null>(null);
  const [trocandoToken, setTrocandoToken] = useState(false);
  const [confirmarSaida, setConfirmarSaida] = useState(false);

  const conectar = useMutation({
    mutationFn: async (codEstab?: string) =>
      apiClient.post<{ data: ConexaoBelle }>(ROTA, { token: token.trim(), ...(codEstab ? { cod_estab: codEstab } : {}) }),
    onError: (err) => {
      const lista = err instanceof ApiError && err.status === 409 ? (err.details?.unidades as Unidade[] | undefined) : undefined;
      if (lista?.length) {
        setUnidades(lista);
        return;
      }
      showApiError(err);
    },
    onSuccess: () => {
      toast.success("Belle conectado. A primeira importação começa agora.");
      setToken("");
      setUnidades(null);
      setTrocandoToken(false);
      void qc.invalidateQueries({ queryKey: CHAVE });
      sincronizar.mutate();
    },
  });

  const sincronizar = useMutation({
    mutationFn: async () =>
      (await apiClient.post<{ data: { ok: boolean; erro: string | null; contagem: { criados: number; atualizados: number } } }>(`${ROTA}/sincronizar`, {})).data,
    onError: showApiError,
    onSuccess: (r) => {
      if (r.ok) toast.success(`Sincronizado: ${r.contagem.criados} novos, ${r.contagem.atualizados} atualizados.`);
      else toast.error(r.erro ?? "A sincronização falhou.");
      void qc.invalidateQueries({ queryKey: CHAVE });
    },
  });

  const desconectar = useMutation({
    mutationFn: async () => apiClient.delete(ROTA),
    onError: showApiError,
    onSuccess: () => {
      toast.success("Belle desconectado. Os agendamentos já importados continuam na Agenda.");
      setConfirmarSaida(false);
      void qc.invalidateQueries({ queryKey: CHAVE });
    },
  });

  const formulario = (
    <form
      className="flex w-full max-w-lg flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        conectar.mutate(undefined);
      }}
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="token-belle">Token de integração</Label>
        <Input
          id="token-belle"
          autoComplete="off"
          placeholder="Cole aqui o token da tela de integrações do Belle"
          value={token}
          onChange={(e) => setToken(e.target.value)}
        />
        <p className="text-xs text-muted-foreground">
          No Belle, entre como administrador e abra a tela de integrações. Se não achar, peça ao suporte do Belle o
          &ldquo;token de integração externa (API)&rdquo; da sua unidade.
        </p>
      </div>
      {unidades && (
        <div className="flex flex-col gap-2 rounded-md border p-3">
          <p className="text-sm">Este token enxerga mais de uma unidade. Qual é a desta conta?</p>
          {unidades.map((u) => (
            <Button key={u.codigo} type="button" variant="outline" disabled={conectar.isPending} onClick={() => conectar.mutate(u.codigo)}>
              {u.nome || `Unidade ${u.codigo}`}
            </Button>
          ))}
        </div>
      )}
      <div className="flex gap-2">
        <Button type="submit" disabled={conectar.isPending || token.trim().length < 8}>
          {conectar.isPending ? "Conferindo no Belle…" : "Conectar"}
        </Button>
        {conexao && (
          <Button type="button" variant="ghost" onClick={() => setTrocandoToken(false)}>
            Cancelar
          </Button>
        )}
      </div>
    </form>
  );

  if (!conexao) {
    return (
      <Card className="flex flex-col items-start gap-4 p-6">
        <CalendarCheck size={28} className="text-muted-foreground" />
        <div>
          <h2 className="font-medium">Belle não conectado</h2>
          <p className="text-sm text-muted-foreground">
            Depois de conectar, os agendamentos dos próximos 60 dias entram na Agenda em poucos minutos. Cada
            paciente vira um contato (pelo celular, sem duplicar quem já conversa pelo WhatsApp).
          </p>
        </div>
        {canWrite ? formulario : <p className="text-sm text-muted-foreground">Só um administrador pode conectar.</p>}
      </Card>
    );
  }

  const s = conexao.last_sync_stats ?? {};
  const st = STATUS[conexao.status];
  return (
    <div className="flex flex-col gap-4">
      <Card className="flex flex-col gap-4 p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="font-medium">{conexao.external_account_name ?? `Unidade ${conexao.external_account_id}`}</h2>
            <p className={`text-sm font-medium ${st.classe}`}>{st.rotulo}</p>
            {conexao.last_error && <p className="mt-1 text-xs text-destructive">{conexao.last_error}</p>}
            <p className="mt-1 text-xs text-muted-foreground">
              Token terminado em ····{conexao.credential_last4} · última sincronização: {quando(conexao.last_sync_at)}
            </p>
          </div>
          {canWrite && (
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => sincronizar.mutate()} disabled={sincronizar.isPending}>
                {sincronizar.isPending ? "Sincronizando… (até 1 min)" : "Sincronizar agora"}
              </Button>
              <Button variant="outline" onClick={() => setTrocandoToken(true)}>
                Trocar token
              </Button>
              <Button variant="ghost" className="text-destructive hover:text-destructive" onClick={() => setConfirmarSaida(true)}>
                Desconectar
              </Button>
            </div>
          )}
        </div>

        {!conexao.initial_sync_done_at && (
          <p className="rounded-md bg-muted px-3 py-2 text-sm">
            Primeira importação em andamento: os próximos 60 dias entram em fatias, a cada 10 minutos. Até terminar, o
            histórico entra em silêncio — sem mexer no funil nem na timeline dos negócios.
          </p>
        )}

        <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
          <Numero rotulo="Agendamentos novos" valor={s.criados} />
          <Numero rotulo="Atualizados" valor={s.atualizados} />
          <Numero rotulo="Removidos no Belle" valor={s.cancelados_por_remocao} />
          <Numero rotulo="Contatos criados" valor={s.contatos_criados} />
          <Numero rotulo="Salas criadas" valor={s.salas_criadas} />
          <Numero rotulo="Sem celular válido" valor={s.sem_telefone} destaque={(s.sem_telefone ?? 0) > 0} />
        </dl>
        <p className="text-xs text-muted-foreground">Números da última rodada.</p>

        {trocandoToken && canWrite && formulario}
      </Card>

      <Card className="flex flex-col gap-2 p-6 text-sm">
        <h2 className="font-medium">Como funciona</h2>
        <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
          <li>O Belle é quem manda: remarcar, cancelar e mudar status se faz lá. Na Agenda esses agendamentos aparecem com o selo &ldquo;Belle&rdquo; e não podem ser editados.</li>
          <li>Horário, duração e sala são exatamente os do Belle. Cada sala do Belle vira uma sala na Agenda.</li>
          <li>
            Os agendamentos do Belle entram nas{" "}
            <Link href="/app/agenda" className="underline">
              automações de lembrete e confirmação da Agenda
            </Link>{" "}
            como qualquer outro. Quando a paciente responde, o status aparece aqui no CRM.
          </li>
          <li>Paciente que já é negócio no funil ganha o agendamento na timeline e anda para a etapa de agendamento.</li>
        </ul>
      </Card>

      <AlertDialog open={confirmarSaida} onOpenChange={setConfirmarSaida}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Desconectar o Belle?</AlertDialogTitle>
            <AlertDialogDescription>
              Os agendamentos já importados continuam na Agenda, mas param de ser atualizados. Para voltar, basta colar o
              token de novo.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={desconectar.isPending}>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={() => desconectar.mutate()} disabled={desconectar.isPending}>
              {desconectar.isPending ? "Desconectando…" : "Desconectar"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function Numero({ rotulo, valor, destaque }: { rotulo: string; valor: number | undefined; destaque?: boolean }) {
  return (
    <div className="rounded-md border px-3 py-2">
      <dt className="text-xs text-muted-foreground">{rotulo}</dt>
      <dd className={`text-lg font-semibold tabular-nums ${destaque ? "text-amber-600 dark:text-amber-400" : ""}`}>{valor ?? 0}</dd>
    </div>
  );
}
