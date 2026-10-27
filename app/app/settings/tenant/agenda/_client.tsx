"use client";
import { ArrowDown, ArrowUp, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EditorDeHorario, horarioValido } from "@/components/agenda/EditorDeHorario";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import { useAtualizarTipoDeCompromisso, useCriarTipoDeCompromisso, useEventTypes } from "@/hooks/agenda/useEventTypes";
import {
  useAtualizarSala,
  useBloqueios,
  useCriarBloqueio,
  useCriarSala,
  useRemoverBloqueio,
  useSalas,
  useSalvarHorarioPadrao,
} from "@/hooks/agenda/useSalas";
import { dataLocalDe, somaDias } from "@/lib/agenda/fuso";
import type { HorarioDeFuncionamento, Sala, TipoDeCompromisso } from "@/lib/agenda/tipos";

function slugifica(nome: string): string {
  return nome
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

/**
 * Configuração da Agenda por sala (migration 0200): salas, horário da
 * clínica, serviços (e em quais salas cada um pode ser feito) e bloqueios.
 */
export function AgendaSettingsClient() {
  return (
    <Tabs defaultValue="salas" className="max-w-3xl">
      <TabsList className="flex-wrap">
        <TabsTrigger value="salas">Salas</TabsTrigger>
        <TabsTrigger value="horario">Horário da clínica</TabsTrigger>
        <TabsTrigger value="servicos">Serviços</TabsTrigger>
        <TabsTrigger value="bloqueios">Bloqueios</TabsTrigger>
      </TabsList>
      <TabsContent value="salas" className="pt-4">
        <SalasTab />
      </TabsContent>
      <TabsContent value="horario" className="pt-4">
        <HorarioTab />
      </TabsContent>
      <TabsContent value="servicos" className="pt-4">
        <ServicosTab />
      </TabsContent>
      <TabsContent value="bloqueios" className="pt-4">
        <BloqueiosTab />
      </TabsContent>
    </Tabs>
  );
}

// ---------------------------------------------------------------------------
// Salas
// ---------------------------------------------------------------------------

function SalasTab() {
  const { data, isLoading } = useSalas({ incluirInativas: true });
  const criar = useCriarSala();
  const atualizar = useAtualizarSala();
  const [nome, setNome] = useState("");

  const ativas = (data?.salas ?? []).filter((s) => s.is_active);
  const inativas = (data?.salas ?? []).filter((s) => !s.is_active);

  async function adicionar() {
    if (!nome.trim()) return;
    try {
      await criar.mutateAsync({ name: nome.trim() });
      toast.success("Sala criada.");
      setNome("");
    } catch (err) {
      showApiError(err);
    }
  }

  async function mover(indice: number, delta: -1 | 1) {
    const alvo = ativas[indice];
    const vizinho = ativas[indice + delta];
    if (!alvo || !vizinho) return;
    try {
      await atualizar.mutateAsync({ id: alvo.id, input: { position: vizinho.position } });
      await atualizar.mutateAsync({ id: vizinho.id, input: { position: alvo.position } });
    } catch (err) {
      showApiError(err);
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Salas da clínica</CardTitle>
          <CardDescription>
            Cada sala vira uma coluna na Agenda e só aceita um atendimento por vez. Ex.: &quot;Sala 1&quot;, &quot;Sala 2&quot;, &quot;Avaliação&quot;.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex items-end gap-3">
          <div className="flex-1 space-y-1.5">
            <Label htmlFor="nova-sala">Nome da sala</Label>
            <Input
              id="nova-sala"
              placeholder="Ex.: Sala 1"
              value={nome}
              maxLength={60}
              onChange={(e) => setNome(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void adicionar()}
            />
          </div>
          <Button disabled={criar.isPending || !nome.trim()} onClick={() => void adicionar()}>
            Adicionar sala
          </Button>
        </CardContent>
      </Card>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Carregando…</p>
      ) : ativas.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nenhuma sala ainda — adicione a primeira acima.</p>
      ) : (
        <ul className="space-y-2">
          {ativas.map((s, i) => (
            <LinhaDaSala
              key={s.id}
              sala={s}
              horarioPadrao={data!.horario_padrao}
              primeira={i === 0}
              ultima={i === ativas.length - 1}
              onSubir={() => void mover(i, -1)}
              onDescer={() => void mover(i, 1)}
            />
          ))}
        </ul>
      )}

      {inativas.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground">Salas desativadas</p>
          {inativas.map((s) => (
            <div key={s.id} className="flex items-center justify-between rounded-md border border-dashed px-3 py-2 text-sm">
              <span className="text-muted-foreground">{s.name}</span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  void atualizar
                    .mutateAsync({ id: s.id, input: { is_active: true } })
                    .then(() => toast.success("Sala reativada."))
                    .catch(showApiError)
                }
              >
                Reativar
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function LinhaDaSala({
  sala,
  horarioPadrao,
  primeira,
  ultima,
  onSubir,
  onDescer,
}: {
  sala: Sala;
  horarioPadrao: HorarioDeFuncionamento;
  primeira: boolean;
  ultima: boolean;
  onSubir: () => void;
  onDescer: () => void;
}) {
  const atualizar = useAtualizarSala();
  const [nome, setNome] = useState(sala.name);
  const [horarioProprio, setHorarioProprio] = useState<HorarioDeFuncionamento | null>(sala.schedule);
  const [expandida, setExpandida] = useState(false);

  async function salvar(input: Parameters<typeof atualizar.mutateAsync>[0]["input"], mensagem: string) {
    try {
      await atualizar.mutateAsync({ id: sala.id, input });
      toast.success(mensagem);
    } catch (err) {
      showApiError(err);
    }
  }

  return (
    <li className="rounded-md border bg-card">
      <div className="flex flex-wrap items-center gap-2 px-3 py-2">
        <div className="flex flex-col">
          <Button variant="ghost" size="icon" className="h-5 w-5" disabled={primeira} aria-label="Subir" onClick={onSubir}>
            <ArrowUp className="h-3 w-3" />
          </Button>
          <Button variant="ghost" size="icon" className="h-5 w-5" disabled={ultima} aria-label="Descer" onClick={onDescer}>
            <ArrowDown className="h-3 w-3" />
          </Button>
        </div>
        <Input
          className="h-8 max-w-[220px]"
          value={nome}
          maxLength={60}
          onChange={(e) => setNome(e.target.value)}
          onBlur={() => nome.trim() && nome.trim() !== sala.name && void salvar({ name: nome.trim() }, "Nome atualizado.")}
          aria-label="Nome da sala"
        />
        <span className="text-xs text-muted-foreground">{sala.schedule ? "Horário próprio" : "Horário da clínica"}</span>
        <div className="ml-auto flex gap-1">
          <Button variant="ghost" size="sm" onClick={() => setExpandida((v) => !v)}>
            {expandida ? "Fechar" : "Horário"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="text-destructive hover:text-destructive"
            onClick={() => void salvar({ is_active: false }, "Sala desativada.")}
          >
            Desativar
          </Button>
        </div>
      </div>

      {expandida && (
        <div className="space-y-3 border-t px-3 py-3">
          <label className="flex items-center gap-2 text-sm">
            <Switch
              checked={horarioProprio !== null}
              onCheckedChange={(v) => setHorarioProprio(v ? (sala.schedule ?? horarioPadrao) : null)}
            />
            Esta sala tem horário diferente do da clínica
          </label>
          {horarioProprio && <EditorDeHorario valor={horarioProprio} onChange={setHorarioProprio} />}
          <Button
            size="sm"
            disabled={atualizar.isPending || (horarioProprio !== null && !horarioValido(horarioProprio))}
            onClick={() => void salvar({ schedule: horarioProprio }, "Horário da sala salvo.")}
          >
            Salvar horário da sala
          </Button>
        </div>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------
// Horário da clínica
// ---------------------------------------------------------------------------

function HorarioTab() {
  const { data, isLoading } = useSalas();
  const salvar = useSalvarHorarioPadrao();
  const [horario, setHorario] = useState<HorarioDeFuncionamento | null>(null);

  useEffect(() => {
    if (data && horario === null) setHorario(data.horario_padrao);
  }, [data, horario]);

  if (isLoading || !horario) return <p className="text-sm text-muted-foreground">Carregando…</p>;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Horário de funcionamento</CardTitle>
        <CardDescription>Vale para todas as salas que não têm horário próprio. Só esses horários aparecem para agendar.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <EditorDeHorario valor={horario} onChange={setHorario} />
        <Button
          disabled={salvar.isPending || !horarioValido(horario)}
          onClick={() =>
            void salvar
              .mutateAsync(horario)
              .then(() => toast.success("Horário da clínica salvo."))
              .catch(showApiError)
          }
        >
          Salvar horário
        </Button>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Serviços
// ---------------------------------------------------------------------------

function ServicosTab() {
  const { data: tipos, isLoading } = useEventTypes({ incluirInativos: true });
  const { data: dadosDasSalas } = useSalas();
  const criar = useCriarTipoDeCompromisso();
  const [nome, setNome] = useState("");
  const [duracao, setDuracao] = useState(30);

  async function adicionar() {
    if (nome.trim().length < 2) return;
    try {
      await criar.mutateAsync({ name: nome.trim(), slug: slugifica(nome), duration_minutes: duracao });
      toast.success("Serviço criado.");
      setNome("");
      setDuracao(30);
    } catch (err) {
      showApiError(err);
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Serviços</CardTitle>
          <CardDescription>O que se agenda (ex.: Avaliação, Depilação a laser) e quanto tempo ocupa a sala.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-end gap-3">
          <div className="min-w-[180px] flex-1 space-y-1.5">
            <Label htmlFor="novo-servico">Nome</Label>
            <Input id="novo-servico" placeholder="Ex.: Avaliação" value={nome} onChange={(e) => setNome(e.target.value)} />
          </div>
          <div className="w-28 space-y-1.5">
            <Label htmlFor="novo-servico-duracao">Duração (min)</Label>
            <Input
              id="novo-servico-duracao"
              type="number"
              min={5}
              max={480}
              step={5}
              value={duracao}
              onChange={(e) => setDuracao(Number(e.target.value))}
            />
          </div>
          <Button disabled={criar.isPending || nome.trim().length < 2} onClick={() => void adicionar()}>
            Adicionar
          </Button>
        </CardContent>
      </Card>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Carregando…</p>
      ) : (tipos ?? []).length === 0 ? (
        <p className="text-sm text-muted-foreground">Nenhum serviço ainda.</p>
      ) : (
        <ul className="space-y-2">
          {(tipos ?? []).map((t) => (
            <LinhaDoServico key={t.id} tipo={t} salas={dadosDasSalas?.salas ?? []} />
          ))}
        </ul>
      )}
    </div>
  );
}

function LinhaDoServico({ tipo, salas }: { tipo: TipoDeCompromisso; salas: Sala[] }) {
  const atualizar = useAtualizarTipoDeCompromisso();
  const [expandido, setExpandido] = useState(false);
  const [duracao, setDuracao] = useState(tipo.duration_minutes);
  const [intervalo, setIntervalo] = useState<number | null>(tipo.slot_interval_minutes);
  const [janelaIa, setJanelaIa] = useState(tipo.booking_window_days);
  const [antecedenciaIa, setAntecedenciaIa] = useState(Math.round(tipo.minimum_notice_minutes / 60));
  const [salasPermitidas, setSalasPermitidas] = useState<string[]>(tipo.room_ids ?? []);

  async function salvar() {
    try {
      await atualizar.mutateAsync({
        id: tipo.id,
        input: {
          duration_minutes: duracao,
          slot_interval_minutes: intervalo,
          booking_window_days: janelaIa,
          minimum_notice_minutes: antecedenciaIa * 60,
          room_ids: salasPermitidas,
        },
      });
      toast.success("Serviço salvo.");
      setExpandido(false);
    } catch (err) {
      showApiError(err);
    }
  }

  const resumoSalas =
    (tipo.room_ids ?? []).length === 0
      ? "Qualquer sala"
      : salas
          .filter((s) => tipo.room_ids!.includes(s.id))
          .map((s) => s.name)
          .join(", ");

  return (
    <li className="rounded-md border bg-card">
      <div className="flex flex-wrap items-center gap-3 px-3 py-2">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">
            {tipo.name}
            {!tipo.is_active && <span className="ml-2 text-xs font-normal text-muted-foreground">(inativo)</span>}
          </p>
          <p className="text-xs text-muted-foreground">
            {tipo.duration_minutes}min · {resumoSalas}
          </p>
        </div>
        <Switch
          checked={tipo.is_active}
          aria-label="Serviço ativo"
          onCheckedChange={(v) =>
            void atualizar
              .mutateAsync({ id: tipo.id, input: { is_active: v } })
              .then(() => toast.success(v ? "Serviço ativado." : "Serviço desativado."))
              .catch(showApiError)
          }
        />
        <Button variant="ghost" size="sm" onClick={() => setExpandido((v) => !v)}>
          {expandido ? "Fechar" : "Editar"}
        </Button>
      </div>

      {expandido && (
        <div className="space-y-4 border-t px-3 py-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Duração (min)</Label>
              <Input type="number" min={5} max={480} step={5} value={duracao} onChange={(e) => setDuracao(Number(e.target.value))} />
            </div>
            <div className="space-y-1.5">
              <Label>Horários de quanto em quanto tempo</Label>
              <Select value={String(intervalo ?? 0)} onValueChange={(v) => setIntervalo(v === "0" ? null : Number(v))}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="0">Igual à duração</SelectItem>
                  <SelectItem value="15">A cada 15 min</SelectItem>
                  <SelectItem value="30">A cada 30 min</SelectItem>
                  <SelectItem value="60">A cada 1 hora</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <fieldset className="space-y-1.5">
            <legend className="text-sm font-medium">Em quais salas pode ser feito</legend>
            <p className="text-xs text-muted-foreground">Nenhuma marcada = qualquer sala.</p>
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              {salas.map((s) => (
                <label key={s.id} className="flex cursor-pointer items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-primary"
                    checked={salasPermitidas.includes(s.id)}
                    onChange={(e) =>
                      setSalasPermitidas((prev) => (e.target.checked ? [...prev, s.id] : prev.filter((id) => id !== s.id)))
                    }
                  />
                  {s.name}
                </label>
              ))}
            </div>
          </fieldset>

          <fieldset className="space-y-1.5">
            <legend className="text-sm font-medium">Agendamento pela IA</legend>
            <p className="text-xs text-muted-foreground">
              A equipe pode agendar para qualquer dia. Estes limites valem só para o que o agente de IA oferece ao cliente.
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>Até quantos dias à frente</Label>
                <Input type="number" min={1} max={365} value={janelaIa} onChange={(e) => setJanelaIa(Number(e.target.value))} />
              </div>
              <div className="space-y-1.5">
                <Label>Antecedência mínima (horas)</Label>
                <Input
                  type="number"
                  min={0}
                  max={720}
                  value={antecedenciaIa}
                  onChange={(e) => setAntecedenciaIa(Number(e.target.value))}
                />
              </div>
            </div>
          </fieldset>

          <Button size="sm" disabled={atualizar.isPending} onClick={() => void salvar()}>
            Salvar serviço
          </Button>
        </div>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------
// Bloqueios
// ---------------------------------------------------------------------------

const CLINICA_INTEIRA = "__clinica__";

function BloqueiosTab() {
  const { data: dadosDasSalas } = useSalas();
  const tz = dadosDasSalas?.horario_padrao.timezone ?? "America/Sao_Paulo";
  const [hoje] = useState(() => dataLocalDe(new Date(), tz));
  const { data: bloqueios, isLoading } = useBloqueios(hoje, somaDias(hoje, 365));
  const criar = useCriarBloqueio();
  const remover = useRemoverBloqueio();

  const [sala, setSala] = useState(CLINICA_INTEIRA);
  const [data, setData] = useState(hoje);
  const [diaInteiro, setDiaInteiro] = useState(true);
  const [inicio, setInicio] = useState("12:00");
  const [fim, setFim] = useState("13:00");
  const [motivo, setMotivo] = useState("");

  const salas = dadosDasSalas?.salas ?? [];
  const nomeDaSala = (id: string | null) => (id ? (salas.find((s) => s.id === id)?.name ?? "Sala removida") : "Clínica inteira");

  async function adicionar() {
    try {
      await criar.mutateAsync({
        room_id: sala === CLINICA_INTEIRA ? null : sala,
        date: data,
        start_time: diaInteiro ? null : inicio,
        end_time: diaInteiro ? null : fim,
        reason: motivo.trim() || null,
      });
      toast.success("Bloqueio criado.");
      setMotivo("");
    } catch (err) {
      showApiError(err);
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Bloquear horário</CardTitle>
          <CardDescription>Feriado, manutenção de equipamento, folga — o horário bloqueado não aparece para agendar.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Onde</Label>
              <Select value={sala} onValueChange={setSala}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={CLINICA_INTEIRA}>Clínica inteira</SelectItem>
                  {salas.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="bloqueio-data">Dia</Label>
              <Input id="bloqueio-data" type="date" min={hoje} value={data} onChange={(e) => setData(e.target.value)} />
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={diaInteiro} onCheckedChange={setDiaInteiro} />
            Dia inteiro
          </label>
          {!diaInteiro && (
            <div className="flex items-center gap-2">
              <Input type="time" step={900} className="w-28" value={inicio} onChange={(e) => setInicio(e.target.value)} aria-label="Início" />
              <span className="text-sm text-muted-foreground">às</span>
              <Input type="time" step={900} className="w-28" value={fim} onChange={(e) => setFim(e.target.value)} aria-label="Fim" />
            </div>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="bloqueio-motivo">Motivo (opcional)</Label>
            <Input id="bloqueio-motivo" maxLength={200} value={motivo} onChange={(e) => setMotivo(e.target.value)} placeholder="Ex.: Feriado" />
          </div>
          <Button disabled={criar.isPending || !data || (!diaInteiro && fim <= inicio)} onClick={() => void adicionar()}>
            Bloquear
          </Button>
        </CardContent>
      </Card>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Carregando…</p>
      ) : (bloqueios ?? []).length === 0 ? (
        <p className="text-sm text-muted-foreground">Nenhum bloqueio programado.</p>
      ) : (
        <ul className="space-y-2">
          {(bloqueios ?? []).map((b) => (
            <li key={b.id} className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
              <span>
                <strong>{new Date(`${b.date}T12:00:00Z`).toLocaleDateString("pt-BR", { timeZone: "UTC" })}</strong> ·{" "}
                {b.start_time && b.end_time ? `${b.start_time.slice(0, 5)}–${b.end_time.slice(0, 5)}` : "dia inteiro"} · {nomeDaSala(b.room_id)}
                {b.reason ? <span className="text-muted-foreground"> · {b.reason}</span> : null}
              </span>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Remover bloqueio"
                disabled={remover.isPending}
                onClick={() =>
                  void remover
                    .mutateAsync(b.id)
                    .then(() => toast.success("Bloqueio removido."))
                    .catch(showApiError)
                }
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
