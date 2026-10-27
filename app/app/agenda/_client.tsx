"use client";
import { ChevronLeft, ChevronRight, Filter, Plus } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DetalheDoCompromisso } from "@/components/agenda/DetalheDoCompromisso";
import { GradeDaAgenda } from "@/components/agenda/GradeDaAgenda";
import { MarcarCompromissoDialog } from "@/components/agenda/MarcarCompromissoDialog";
import { MiniCalendario } from "@/components/agenda/MiniCalendario";
import { useActiveOrg } from "@/hooks/auth/AuthProvider";
import { useAgendaAoVivo, useAgendamentos, type CompromissoDaLista } from "@/hooks/agenda/useAgendamentos";
import { useBloqueios, useSalas } from "@/hooks/agenda/useSalas";
import { useAttendants } from "@/hooks/team/useAttendants";
import { dataLocalDe, instanteDoMomentoLocal, somaDias } from "@/lib/agenda/fuso";
import { RÓTULO_DO_STATUS, STATUS_DO_COMPROMISSO, type StatusDoCompromisso } from "@/lib/agenda/tipos";
import { cn } from "@/lib/utils";

const TODOS = "__todos__";
/** Cancelado fica fora por padrão: a grade mostra o que ocupa o dia. */
const STATUS_PADRAO: StatusDoCompromisso[] = STATUS_DO_COMPROMISSO.filter((s) => s !== "cancelled");

/**
 * Agenda por SALA (migration 0200) — layout pedido pelo dono do produto com
 * referência no Zandu: mini-calendário à esquerda para pular para qualquer
 * dia, uma coluna por sala, clique no vazio para agendar, clique no
 * compromisso para editar. No celular a lateral recolhe atrás de "Filtros"
 * e a grade mostra uma sala por vez.
 */
export function AgendaClient() {
  const org = useActiveOrg();
  const { data: dadosDasSalas, isLoading: carregandoSalas } = useSalas();
  const { data: atendentes } = useAttendants();
  const tz = dadosDasSalas?.horario_padrao.timezone ?? "America/Sao_Paulo";

  const [agora, setAgora] = useState(() => new Date());
  // A linha vermelha do "agora" anda sozinha; a página aberta o dia todo não fica parada.
  useEffect(() => {
    const t = setInterval(() => setAgora(new Date()), 60_000);
    return () => clearInterval(t);
  }, []);
  const hoje = dataLocalDe(agora, tz);
  const [dia, setDia] = useState(hoje);

  const [salasOcultas, setSalasOcultas] = useState<Set<string>>(new Set());
  const [statusVisiveis, setStatusVisiveis] = useState<Set<StatusDoCompromisso>>(new Set(STATUS_PADRAO));
  const [profissional, setProfissional] = useState(TODOS);
  const [filtrosAbertos, setFiltrosAbertos] = useState(false);

  const [agendar, setAgendar] = useState<{ roomId?: string | null; data?: string; hhmm?: string } | null>(null);
  const [emDetalhe, setEmDetalhe] = useState<CompromissoDaLista | null>(null);
  const [emEdicao, setEmEdicao] = useState<CompromissoDaLista | null>(null);

  const { de, ate } = useMemo(
    () => ({
      de: instanteDoMomentoLocal(dia, "00:00", tz).toISOString(),
      ate: instanteDoMomentoLocal(somaDias(dia, 1), "00:00", tz).toISOString(),
    }),
    [dia, tz],
  );
  const { data: compromissos, isLoading: carregandoCompromissos } = useAgendamentos(de, ate);
  const { data: bloqueios } = useBloqueios(dia, dia);
  useAgendaAoVivo(org?.orgId);

  const salas = dadosDasSalas?.salas ?? [];
  const salasVisiveis = salas.filter((s) => !salasOcultas.has(s.id));

  const nomes = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of atendentes?.data ?? []) m.set(a.user_id, a.name ?? a.email ?? "Sem nome");
    return m;
  }, [atendentes]);
  const nomeDoProfissional = (id: string | null) => (id ? (nomes.get(id) ?? null) : null);
  const nomeDaSala = (id: string | null) => salas.find((s) => s.id === id)?.name ?? "Sem sala";

  const visiveis = (compromissos ?? []).filter(
    (c) =>
      statusVisiveis.has(c.status) &&
      (profissional === TODOS || c.owner_user_id === profissional) &&
      (!c.room_id || !salasOcultas.has(c.room_id)),
  );

  const contagem = useMemo(() => {
    const vivos = (compromissos ?? []).filter((c) => c.status !== "cancelled");
    return {
      total: vivos.length,
      confirmados: vivos.filter((c) => c.status === "confirmed").length,
      naoConfirmados: vivos.filter((c) => c.status === "declined").length,
    };
  }, [compromissos]);

  function alternaSala(id: string) {
    setSalasOcultas((prev) => {
      const prox = new Set(prev);
      if (prox.has(id)) prox.delete(id);
      else prox.add(id);
      return prox;
    });
  }

  function alternaStatus(s: StatusDoCompromisso) {
    setStatusVisiveis((prev) => {
      const prox = new Set(prev);
      if (prox.has(s)) prox.delete(s);
      else prox.add(s);
      return prox;
    });
  }

  const rotuloDoDia = new Date(`${dia}T12:00:00Z`).toLocaleDateString("pt-BR", {
    weekday: "long",
    day: "2-digit",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 lg:flex-row">
      {/* Lateral: calendário, agendar e filtros */}
      <aside className="flex shrink-0 flex-col gap-4 lg:w-72">
        <Button size="lg" className="w-full" onClick={() => setAgendar({ data: dia })}>
          <Plus className="mr-2 h-4 w-4" /> Agendar
        </Button>

        <div className="rounded-lg border bg-card p-3">
          <MiniCalendario valor={dia} hoje={hoje} onSelecionar={setDia} />
          <div className="mt-2 grid grid-cols-3 gap-1">
            <Button variant="outline" size="sm" aria-label="Dia anterior" onClick={() => setDia(somaDias(dia, -1))}>
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button variant="outline" size="sm" onClick={() => setDia(hoje)}>
              Hoje
            </Button>
            <Button variant="outline" size="sm" aria-label="Próximo dia" onClick={() => setDia(somaDias(dia, 1))}>
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>

        <Button variant="outline" className="lg:hidden" onClick={() => setFiltrosAbertos((v) => !v)}>
          <Filter className="mr-2 h-4 w-4" /> {filtrosAbertos ? "Esconder filtros" : "Filtros"}
        </Button>

        <div className={cn("space-y-4 rounded-lg border bg-card p-3", !filtrosAbertos && "hidden lg:block")}>
          {salas.length > 1 && (
            <fieldset className="space-y-1.5">
              <legend className="mb-1 text-xs font-medium text-muted-foreground">Salas</legend>
              {salas.map((s) => (
                <label key={s.id} className="flex cursor-pointer items-center gap-2 text-sm">
                  <input type="checkbox" className="h-4 w-4 accent-primary" checked={!salasOcultas.has(s.id)} onChange={() => alternaSala(s.id)} />
                  {s.name}
                </label>
              ))}
            </fieldset>
          )}

          <fieldset className="space-y-1.5">
            <legend className="mb-1 text-xs font-medium text-muted-foreground">Status</legend>
            {STATUS_DO_COMPROMISSO.map((s) => (
              <label key={s} className="flex cursor-pointer items-center gap-2 text-sm">
                <input type="checkbox" className="h-4 w-4 accent-primary" checked={statusVisiveis.has(s)} onChange={() => alternaStatus(s)} />
                {RÓTULO_DO_STATUS[s]}
              </label>
            ))}
          </fieldset>

          <div className="space-y-1.5">
            <Label className="text-xs font-medium text-muted-foreground">Profissional</Label>
            <Select value={profissional} onValueChange={setProfissional}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={TODOS}>Todos</SelectItem>
                {(atendentes?.data ?? []).map((a) => (
                  <SelectItem key={a.user_id} value={a.user_id}>
                    {a.name ?? a.email ?? "Sem nome"}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </aside>

      {/* Grade do dia */}
      <section className="flex min-h-[60vh] min-w-0 flex-1 flex-col gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-lg font-semibold capitalize">{rotuloDoDia}</h2>
          <p className="text-sm text-muted-foreground">
            {contagem.total} agendamento(s) · {contagem.confirmados} confirmado(s)
            {contagem.naoConfirmados > 0 && <span className="text-red-600"> · {contagem.naoConfirmados} não confirmado(s)</span>}
          </p>
        </div>

        {carregandoSalas || carregandoCompromissos ? (
          <p className="py-8 text-center text-sm text-muted-foreground">Carregando…</p>
        ) : (
          <GradeDaAgenda
            data={dia}
            hoje={hoje}
            agora={agora}
            horarioPadrao={dadosDasSalas?.horario_padrao ?? { timezone: tz, windows: [] }}
            salas={salasVisiveis}
            compromissos={visiveis}
            bloqueios={bloqueios ?? []}
            nomeDoProfissional={nomeDoProfissional}
            onHorarioVazio={(roomId, hhmm) => setAgendar({ roomId, data: dia, hhmm })}
            onCompromisso={setEmDetalhe}
          />
        )}
      </section>

      <MarcarCompromissoDialog
        open={agendar !== null}
        onOpenChange={(v) => !v && setAgendar(null)}
        inicial={agendar ?? undefined}
      />

      <MarcarCompromissoDialog
        open={emEdicao !== null}
        onOpenChange={(v) => !v && setEmEdicao(null)}
        compromisso={emEdicao}
      />

      <DetalheDoCompromisso
        key={emDetalhe?.id ?? "nenhum"}
        compromisso={emDetalhe}
        timezone={tz}
        nomeDaSala={nomeDaSala}
        nomeDoProfissional={nomeDoProfissional}
        onFechar={() => setEmDetalhe(null)}
        onEditar={(c) => {
          setEmDetalhe(null);
          setEmEdicao(c);
        }}
      />
    </div>
  );
}
