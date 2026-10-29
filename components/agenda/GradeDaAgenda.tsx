"use client";
import { useMemo, useState, type MouseEvent } from "react";

import type { CompromissoDaLista } from "@/hooks/agenda/useAgendamentos";
import {
  faixaDaGrade,
  janelasAbertas,
  minutosNoDia,
  minutosParaHhmm,
  rotuloDoHorario,
  type BloqueioDoDia,
  type Faixa,
} from "@/lib/agenda/grade";
import { RÓTULO_DO_STATUS, type HorarioDeFuncionamento, type Sala } from "@/lib/agenda/tipos";
import { cn } from "@/lib/utils";

import { CLASSE_DO_CARD, CLASSE_DO_SELO } from "./status";

/** 30 minutos = 52px: cabe nome + serviço num compromisso de 30min sem cortar. */
const PX_POR_MINUTO = 52 / 30;
const SEM_SALA = "__sem_sala__";

interface GradeDaAgendaProps {
  /** "YYYY-MM-DD" no fuso da clínica. */
  data: string;
  hoje: string;
  agora: Date;
  horarioPadrao: HorarioDeFuncionamento;
  salas: Sala[];
  compromissos: CompromissoDaLista[];
  bloqueios: BloqueioDoDia[];
  nomeDoProfissional: (userId: string | null) => string | null;
  onHorarioVazio: (roomId: string, hhmm: string) => void;
  onCompromisso: (c: CompromissoDaLista) => void;
}

interface Coluna {
  id: string;
  nome: string;
  sala: Sala | null;
}

/**
 * A grade do dia, uma coluna por SALA (pedido do dono do produto, referência
 * visual: Zandu). Clicar num espaço vazio abre o agendamento já com sala, dia
 * e hora; clicar num compromisso abre o detalhe (editar, remarcar, status).
 *
 * No celular mostra UMA sala por vez, com abas para trocar — quatro colunas
 * espremidas em 360px seriam ilegíveis.
 */
export function GradeDaAgenda({
  data,
  hoje,
  agora,
  horarioPadrao,
  salas,
  compromissos,
  bloqueios,
  nomeDoProfissional,
  onHorarioVazio,
  onCompromisso,
}: GradeDaAgendaProps) {
  const tz = horarioPadrao.timezone || "America/Sao_Paulo";

  const colunas: Coluna[] = useMemo(() => {
    const lista: Coluna[] = salas.map((s) => ({ id: s.id, nome: s.name, sala: s }));
    // Compromisso sem sala (gravado pela versão antiga durante o deploy) não
    // pode sumir: ganha uma coluna própria até alguém escolher a sala.
    if (compromissos.some((c) => !c.room_id)) lista.push({ id: SEM_SALA, nome: "Sem sala", sala: null });
    return lista;
  }, [salas, compromissos]);

  const [colunaMovel, setColunaMovel] = useState<string | null>(null);
  const colunaAtivaMovel = colunas.find((c) => c.id === colunaMovel)?.id ?? colunas[0]?.id ?? null;

  const intervalos = useMemo(
    () =>
      compromissos.map((c) => {
        const inicio = minutosNoDia(c.starts_at, tz);
        const fim = Math.max(inicio + 15, inicio + (new Date(c.ends_at).getTime() - new Date(c.starts_at).getTime()) / 60_000);
        return { c, inicio, fim };
      }),
    [compromissos, tz],
  );

  const faixa = faixaDaGrade(
    salas,
    horarioPadrao,
    data,
    intervalos.map((i) => ({ inicio: i.inicio, fim: i.fim })),
  );
  const alturaPx = (faixa.fim - faixa.inicio) * PX_POR_MINUTO;
  const marcas = Array.from({ length: (faixa.fim - faixa.inicio) / 30 + 1 }, (_, i) => faixa.inicio + i * 30);
  const agoraMin = data === hoje ? minutosNoDia(agora.toISOString(), tz) : null;

  function clicouNoVazio(coluna: Coluna, e: MouseEvent<HTMLDivElement>) {
    if (!coluna.sala) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const minuto = faixa.inicio + Math.floor((e.clientY - rect.top) / PX_POR_MINUTO / 30) * 30;
    onHorarioVazio(coluna.sala.id, minutosParaHhmm(Math.min(Math.max(minuto, faixa.inicio), faixa.fim - 30)));
  }

  if (colunas.length === 0) {
    return (
      <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
        Nenhuma sala cadastrada ainda. Cadastre as salas da clínica em <strong>Configurações → Agenda</strong> para começar a agendar.
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      {/* Abas de sala — só no celular */}
      {colunas.length > 1 && (
        <div className="flex gap-1 overflow-x-auto md:hidden" role="tablist" aria-label="Salas">
          {colunas.map((c) => (
            <button
              key={c.id}
              type="button"
              role="tab"
              aria-selected={c.id === colunaAtivaMovel}
              onClick={() => setColunaMovel(c.id)}
              className={cn(
                "shrink-0 rounded-full border px-3 py-1 text-sm",
                c.id === colunaAtivaMovel ? "border-primary bg-primary text-primary-foreground" : "bg-background",
              )}
            >
              {c.nome}
            </button>
          ))}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto rounded-lg border bg-card">
        <div className="flex min-w-full">
          {/* Coluna das horas, fixa à esquerda */}
          <div className="sticky left-0 z-20 shrink-0 border-r bg-card">
            <div className="sticky top-0 z-30 h-14 border-b bg-card" />
            <div className="relative w-14" style={{ height: alturaPx }}>
              {marcas.slice(0, -1).map((m) => (
                <span
                  key={m}
                  className={cn(
                    "absolute right-2 -translate-y-1/2 text-[11px] tabular-nums",
                    m % 60 === 0 ? "text-foreground" : "text-muted-foreground",
                  )}
                  style={{ top: (m - faixa.inicio) * PX_POR_MINUTO + (m === faixa.inicio ? 8 : 0) }}
                >
                  {minutosParaHhmm(m)}
                </span>
              ))}
            </div>
          </div>

          {colunas.map((coluna) => {
            const abertas: Faixa[] = coluna.sala ? janelasAbertas(coluna.sala, horarioPadrao, data, bloqueios) : [];
            const fechadas = trechosFechados(faixa, abertas);
            const doDia = intervalos.filter((i) => (coluna.sala ? i.c.room_id === coluna.sala.id : !i.c.room_id));
            return (
              <div
                key={coluna.id}
                className={cn(
                  "min-w-[200px] flex-1 border-r last:border-r-0",
                  coluna.id === colunaAtivaMovel ? "block" : "hidden md:block",
                )}
              >
                <div className="sticky top-0 z-10 flex h-14 items-center gap-2 border-b bg-card px-3">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold uppercase">
                    {coluna.nome.slice(0, 1)}
                  </span>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{coluna.nome}</p>
                    <p className="text-xs text-muted-foreground">
                      {coluna.sala ? rotuloDoHorario(coluna.sala, horarioPadrao, data) : "Escolha uma sala"}
                    </p>
                  </div>
                </div>

                <div
                  className={cn("relative", coluna.sala && "cursor-pointer")}
                  style={{ height: alturaPx }}
                  onClick={(e) => clicouNoVazio(coluna, e)}
                  title={coluna.sala ? "Clique para agendar neste horário" : undefined}
                >
                  {fechadas.map((f) => (
                    <div
                      key={`${f.inicio}-${f.fim}`}
                      className="absolute inset-x-0 bg-[repeating-linear-gradient(135deg,transparent,transparent_6px,var(--muted)_6px,var(--muted)_8px)] opacity-70"
                      style={{ top: (f.inicio - faixa.inicio) * PX_POR_MINUTO, height: (f.fim - f.inicio) * PX_POR_MINUTO }}
                    />
                  ))}

                  {marcas.slice(0, -1).map((m) => (
                    <div
                      key={m}
                      className={cn("absolute inset-x-0 border-t", m % 60 === 0 ? "border-border" : "border-border/40")}
                      style={{ top: (m - faixa.inicio) * PX_POR_MINUTO }}
                    />
                  ))}

                  {agoraMin !== null && agoraMin >= faixa.inicio && agoraMin <= faixa.fim && (
                    <div
                      className="pointer-events-none absolute inset-x-0 z-[5] border-t-2 border-red-500"
                      style={{ top: (agoraMin - faixa.inicio) * PX_POR_MINUTO }}
                    />
                  )}

                  {doDia.map(({ c, inicio, fim }) => {
                    const profissional = nomeDoProfissional(c.owner_user_id);
                    return (
                      <button
                        key={c.id}
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onCompromisso(c);
                        }}
                        className={cn(
                          "agenda-compromisso-caixa absolute left-1 right-1 z-[6] overflow-hidden rounded-md border-l-4 border px-2 py-1 text-left text-xs leading-tight shadow-sm transition hover:z-10 hover:shadow-md",
                          CLASSE_DO_CARD[c.status],
                        )}
                        style={{
                          top: (inicio - faixa.inicio) * PX_POR_MINUTO + 1,
                          height: Math.max((fim - inicio) * PX_POR_MINUTO - 2, 22),
                        }}
                      >
                        <span className="block truncate">
                          <span className="tabular-nums text-muted-foreground">
                            {minutosParaHhmm(inicio)}–{minutosParaHhmm(Math.min(fim, 24 * 60 - 1))}
                          </span>{" "}
                          <span className="font-semibold">
                            {c.contacts?.display_name ?? c.contacts?.phone_number ?? "Sem contato"}
                          </span>
                        </span>
                        <span className={cn("mt-0.5 inline-block rounded px-1.5 py-px text-[10px] font-medium", CLASSE_DO_SELO[c.status])}>
                          {RÓTULO_DO_STATUS[c.status]}
                          {c.client_responded_at && (c.status === "confirmed" || c.status === "declined") ? " · pelo cliente" : ""}
                        </span>
                        {c.external_provider && (
                          <span className="ml-1 mt-0.5 inline-block rounded border border-current/30 px-1.5 py-px text-[10px] font-medium opacity-80">
                            Belle
                          </span>
                        )}
                        <span className="block truncate opacity-90">
                          {c.calendar_event_types?.name ?? c.title}
                          {profissional ? ` · ${profissional}` : ""}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** O complemento das janelas abertas dentro da faixa — o que a grade pinta como fechado. */
function trechosFechados(faixa: Faixa, abertas: Faixa[]): Faixa[] {
  const fechados: Faixa[] = [];
  let cursor = faixa.inicio;
  for (const a of [...abertas].sort((x, y) => x.inicio - y.inicio)) {
    if (a.inicio > cursor) fechados.push({ inicio: cursor, fim: Math.min(a.inicio, faixa.fim) });
    cursor = Math.max(cursor, a.fim);
  }
  if (cursor < faixa.fim) fechados.push({ inicio: cursor, fim: faixa.fim });
  return fechados.filter((f) => f.fim > f.inicio);
}
