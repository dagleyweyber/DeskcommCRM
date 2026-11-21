"use client";
/**
 * Tela de conexão dos sistemas que AVISAM o CRM (Uno, Zandu): o CRM gera um endereço
 * (e, no Uno, um token) e a pessoa cola no sistema da clínica. Sem "sincronizar":
 * cada agendamento chega na hora, pelo aviso.
 */
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
import { copyToClipboard } from "@/lib/clipboard";
import { nomeDoProvedor } from "@/lib/agenda-externa/provedor";
import { CalendarCheck } from "@/lib/ui/icons";

import { LigacaoDeServicos } from "./LigacaoDeServicos";

type Provedor = "uno" | "zandu";

export interface ConexaoPorAvisoDados {
  id: string;
  credential_last4: string | null;
  external_account_id: string | null;
  status: "healthy" | "invalid" | "error";
  last_error: string | null;
  last_sync_at: string | null;
  last_sync_stats: Partial<Record<"criados" | "atualizados" | "contatos_criados" | "sem_telefone" | "salas_criadas", number>>;
  caminho_do_aviso: string | null;
  avisos: { recebidos_24h: number; pendentes: number; ultimo_recebido_em: string | null };
}

const STATUS: Record<ConexaoPorAvisoDados["status"], { rotulo: string; classe: string }> = {
  healthy: { rotulo: "Conectado", classe: "text-emerald-600 dark:text-emerald-400" },
  invalid: { rotulo: "Token recusado — conecte de novo", classe: "text-destructive" },
  error: { rotulo: "Um aviso falhou — o CRM tenta de novo sozinho", classe: "text-amber-600 dark:text-amber-400" },
};

function quando(iso: string | null, vazio: string): string {
  if (!iso) return vazio;
  return new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function Copiavel({ rotulo, valor, id }: { rotulo: string; valor: string; id: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{rotulo}</Label>
      <div className="flex gap-2">
        <Input id={id} readOnly value={valor} className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            void copyToClipboard(valor).then((copiou) =>
              copiou ? toast.success("Copiado.") : toast.error("Não deu para copiar — selecione e copie à mão."),
            );
          }}
        >
          Copiar
        </Button>
      </div>
    </div>
  );
}

function PassoAPasso({ provedor }: { provedor: Provedor }) {
  if (provedor === "uno") {
    return (
      <ol className="list-decimal space-y-1 pl-5 text-sm">
        <li>No Uno, abra <strong>Configurações → Integrações</strong> e clique na aba <strong>Webhooks</strong>.</li>
        <li>Clique em adicionar. Em <strong>Nome</strong>, escreva &ldquo;CRM&rdquo;.</li>
        <li>Em <strong>URL de destino</strong>, cole o endereço acima. Em <strong>Token</strong>, cole o token acima (não clique em &ldquo;Gerar token&rdquo;).</li>
        <li>Em <strong>Agendamentos</strong>, marque <strong>Criação</strong>, <strong>Edição</strong> e <strong>Remoção</strong>. Vendas não precisa.</li>
        <li>Deixe <strong>Ativo</strong> ligado e salve. O próximo agendamento feito no Uno já aparece na Agenda.</li>
      </ol>
    );
  }
  return (
    <ol className="list-decimal space-y-1 pl-5 text-sm">
      <li>No Zandu, abra <strong>Conta → Dispositivos e API</strong>.</li>
      <li>Na parte do <strong>webhook</strong>, cole o endereço acima.</li>
      <li>Marque os eventos de <strong>agendamento</strong> (criado, alterado, confirmado, cancelado e removido) e salve.</li>
      <li>O Zandu avisa que a mudança pode levar até 10 minutos para valer. Depois disso, todo agendamento novo aparece na Agenda.</li>
      <li>Confira também em <strong>Ferramentas → Minhas agendas</strong> se as agendas estão ativas para a API.</li>
    </ol>
  );
}

export function ConexaoPorAviso({
  provedor,
  initialData,
  canWrite,
  origem,
}: {
  provedor: Provedor;
  /** https://dominio-do-crm — o endereço do aviso tem de ser o público, não o interno. */
  origem: string;
  initialData: ConexaoPorAvisoDados | null;
  canWrite: boolean;
}) {
  const nome = nomeDoProvedor(provedor);
  const ROTA = `/api/v1/integrations/agenda/${provedor}`;
  const CHAVE = ["integrations", provedor] as const;
  const qc = useQueryClient();
  const { data: conexao } = useQuery({
    queryKey: CHAVE,
    queryFn: async () => (await apiClient.get<{ data: ConexaoPorAvisoDados | null }>(ROTA)).data,
    initialData,
    refetchInterval: 30_000,
  });

  const [token, setToken] = useState("");
  const [tokenDoUno, setTokenDoUno] = useState<string | null>(null);
  const [trocandoToken, setTrocandoToken] = useState(false);
  const [confirmarSaida, setConfirmarSaida] = useState(false);
  const [confirmarNovoEndereco, setConfirmarNovoEndereco] = useState(false);

  const conectar = useMutation({
    mutationFn: async (args: { novo_endereco?: boolean } = {}) =>
      (
        await apiClient.post<{ data: { token_do_uno: string | null } }>(ROTA, {
          ...(token.trim() ? { token: token.trim() } : {}),
          ...(args.novo_endereco ? { novo_endereco: true } : {}),
        })
      ).data,
    onError: showApiError,
    onSuccess: (r) => {
      if (r.token_do_uno) setTokenDoUno(r.token_do_uno);
      toast.success(`${nome} conectado. Agora cole o endereço no ${nome}.`);
      setToken("");
      setTrocandoToken(false);
      setConfirmarNovoEndereco(false);
      void qc.invalidateQueries({ queryKey: CHAVE });
    },
  });

  const desconectar = useMutation({
    mutationFn: async () => apiClient.delete(ROTA),
    onError: showApiError,
    onSuccess: () => {
      toast.success(`${nome} desconectado. Os agendamentos já importados continuam na Agenda.`);
      setConfirmarSaida(false);
      setTokenDoUno(null);
      void qc.invalidateQueries({ queryKey: CHAVE });
    },
  });

  const formularioDoToken = (
    <form
      className="flex w-full max-w-lg flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        conectar.mutate({});
      }}
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="token-zandu">Token da API do Zandu</Label>
        <Input
          id="token-zandu"
          autoComplete="off"
          placeholder="Cole aqui o token de Conta → Dispositivos e API"
          value={token}
          onChange={(e) => setToken(e.target.value)}
        />
        <p className="text-xs text-muted-foreground">
          O CRM usa o token só para buscar o celular da paciente quando o aviso do Zandu não traz.
        </p>
      </div>
      <div className="flex gap-2">
        <Button type="submit" disabled={conectar.isPending || token.trim().length < 8}>
          {conectar.isPending ? "Conferindo no Zandu…" : "Conectar"}
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
          <h2 className="font-medium">{nome} não conectado</h2>
          <p className="text-sm text-muted-foreground">
            Ao conectar, o CRM gera um endereço para colar no {nome}. Daí em diante, cada agendamento criado, alterado
            ou removido lá aparece na Agenda na hora. Cada paciente vira um contato pelo celular, sem duplicar quem já
            conversa pelo WhatsApp. Agendamentos feitos antes de conectar não vêm.
          </p>
        </div>
        {!canWrite ? (
          <p className="text-sm text-muted-foreground">Só um administrador pode conectar.</p>
        ) : provedor === "zandu" ? (
          formularioDoToken
        ) : (
          <Button onClick={() => conectar.mutate({})} disabled={conectar.isPending}>
            {conectar.isPending ? "Conectando…" : "Conectar o Uno"}
          </Button>
        )}
      </Card>
    );
  }

  const s = conexao.last_sync_stats ?? {};
  const st = STATUS[conexao.status];
  const endereco = conexao.caminho_do_aviso ? `${origem}${conexao.caminho_do_aviso}` : null;

  return (
    <div className="flex flex-col gap-4">
      <Card className="flex flex-col gap-4 p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="font-medium">{conexao.external_account_id ? `${nome} · ${conexao.external_account_id}` : nome}</h2>
            <p className={`text-sm font-medium ${st.classe}`}>{st.rotulo}</p>
            {conexao.last_error && <p className="mt-1 text-xs text-destructive">{conexao.last_error}</p>}
            <p className="mt-1 text-xs text-muted-foreground">
              {conexao.credential_last4 ? `Token terminado em ····${conexao.credential_last4} · ` : ""}
              último aviso: {quando(conexao.avisos.ultimo_recebido_em, "nenhum ainda")}
            </p>
          </div>
          {canWrite && (
            <div className="flex flex-wrap gap-2">
              {provedor === "zandu" && (
                <Button variant="outline" onClick={() => setTrocandoToken(true)}>
                  Trocar token
                </Button>
              )}
              <Button variant="outline" onClick={() => setConfirmarNovoEndereco(true)}>
                {provedor === "uno" ? "Gerar novo endereço e token" : "Gerar novo endereço"}
              </Button>
              <Button variant="ghost" className="text-destructive hover:text-destructive" onClick={() => setConfirmarSaida(true)}>
                Desconectar
              </Button>
            </div>
          )}
        </div>

        {trocandoToken && canWrite && formularioDoToken}

        {canWrite && endereco && (
          <div className="flex flex-col gap-3 rounded-md border p-4">
            <h3 className="text-sm font-medium">O que colar no {nome}</h3>
            <Copiavel id={`endereco-${provedor}`} rotulo="Endereço (URL de destino)" valor={endereco} />
            {provedor === "uno" &&
              (tokenDoUno ? (
                <>
                  <Copiavel id="token-uno" rotulo="Token" valor={tokenDoUno} />
                  <p className="text-xs text-amber-700 dark:text-amber-400">
                    Copie o token agora: por segurança ele só aparece desta vez. Se perder, gere um novo endereço e token.
                  </p>
                </>
              ) : (
                <p className="text-xs text-muted-foreground">
                  O token já foi mostrado quando você conectou. Se não guardou, use &ldquo;Gerar novo endereço e token&rdquo; e
                  atualize os dois no Uno.
                </p>
              ))}
            <PassoAPasso provedor={provedor} />
          </div>
        )}

        <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
          <Numero rotulo="Avisos nas últimas 24 h" valor={conexao.avisos.recebidos_24h} />
          <Numero rotulo="Avisos esperando nova tentativa" valor={conexao.avisos.pendentes} destaque={conexao.avisos.pendentes > 0} />
          <Numero rotulo="Contatos criados (último aviso)" valor={s.contatos_criados} />
          <Numero rotulo="Sem celular válido (último aviso)" valor={s.sem_telefone} destaque={(s.sem_telefone ?? 0) > 0} />
        </dl>
        {(s.sem_telefone ?? 0) > 0 && (
          <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
            O último agendamento chegou sem o celular da paciente e por isso não entrou na Agenda: sem o celular não dá para
            ligar o agendamento à conversa do WhatsApp.
            {provedor === "uno" ? " O aviso do Uno manda só o nome da cliente; confira com o suporte do Uno se dá para incluir o celular." : ""}
          </p>
        )}
      </Card>

      <LigacaoDeServicos canWrite={canWrite} provedor={provedor} />

      <Card className="flex flex-col gap-2 p-6 text-sm">
        <h2 className="font-medium">Como funciona</h2>
        <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
          <li>O {nome} é quem manda: remarcar, cancelar e mudar status se faz lá. Na Agenda esses agendamentos aparecem com o selo &ldquo;{nome}&rdquo; e não podem ser editados.</li>
          <li>Cada sala (ou agenda) do {nome} vira uma sala na Agenda.</li>
          <li>
            Os agendamentos entram nas{" "}
            <Link href="/app/agenda" className="underline">
              automações de lembrete e confirmação da Agenda
            </Link>{" "}
            como qualquer outro. A resposta da paciente aparece aqui no CRM (ela não volta para o {nome}).
          </li>
          <li>Se um aviso falhar, o CRM tenta de novo sozinho. No {nome}, o log de webhooks mostra cada envio.</li>
        </ul>
      </Card>

      <AlertDialog open={confirmarNovoEndereco} onOpenChange={setConfirmarNovoEndereco}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Gerar um endereço novo?</AlertDialogTitle>
            <AlertDialogDescription>
              O endereço atual{provedor === "uno" ? " e o token atual param" : " para"} de funcionar na hora. Depois de gerar,
              cole o novo no {nome}, senão os agendamentos deixam de chegar.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={conectar.isPending}>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={() => conectar.mutate({ novo_endereco: true })} disabled={conectar.isPending}>
              {conectar.isPending ? "Gerando…" : "Gerar novo"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmarSaida} onOpenChange={setConfirmarSaida}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Desconectar o {nome}?</AlertDialogTitle>
            <AlertDialogDescription>
              Os agendamentos já importados continuam na Agenda, mas param de ser atualizados. Para voltar, conecte de novo e
              cole o endereço novo no {nome}.
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
