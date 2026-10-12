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
import { showApiError } from "@/components/feedback/ApiErrorToast";
import { useCancelarAgendamento, type CompromissoDaLista } from "@/hooks/agenda/useAgendamentos";
import type { AttendantAvailability } from "@/hooks/team/useAttendants";
import type { StatusDoCompromisso } from "@/lib/agenda/tipos";
import { cn } from "@/lib/utils";

/** Janela visível da grade — cobre o expediente comum de clínica (07h–21h). */
const HORA_INICIO = 7;
const HORA_FIM = 21;
const ALTURA_HORA_PX = 56;
const PX_POR_MINUTO = ALTURA_HORA_PX / 60;
const ALTURA_GRADE_PX = (HORA_FIM - HORA_INICIO) * ALTURA_HORA_PX;

// `cancelled` nunca renderiza (filtrado antes de chegar aqui) — a chave
// existe só pra satisfazer o Record, que cobre todo StatusDoCompromisso.
//
// ⚠️ `confirmed` aqui é "criado/agendado", não "cliente confirmou presença"
// — `marcarAgendamentoHandler` grava `status: "confirmed"` na hora de
// CRIAR o compromisso, sempre, pra todo mundo (não existe hoje nenhum sinal
// de resposta do cliente — o lembrete automático, `lib/automations/triggers/
// agendamento.ts`, só ENVIA, nunca lê confirmação de volta). Pintar de verde
// por "confirmed" pintaria TODO compromisso de verde no instante em que é
// criado, o oposto do pedido ("verde só quando o cliente confirma"). Por
// isso o verde fica de fora daqui até esse sinal existir de verdade — ver
// conversa com o dono do produto.
const CLASSE_POR_STATUS: Record<StatusDoCompromisso, string> = {
  pending: "border-amber-500/60 bg-amber-500/25 text-foreground",
  confirmed: "border-sky-500/60 bg-sky-500/25 text-foreground",
  completed: "border-muted-foreground/40 bg-muted text-muted-foreground",
  no_show: "border-destructive/60 bg-destructive/20 text-foreground",
  cancelled: "",
};

const RÓTULO_DO_STATUS: Record<StatusDoCompromisso, string> = {
  pending: "Pendente",
  confirmed: "Confirmado",
  cancelled: "Cancelado",
  completed: "Compareceu",
  no_show: "Não compareceu",
};

/** Minutos desde HORA_INICIO — `null` quando cai fora da janela visível. */
function minutosNaGrade(iso: string): number | null {
  const d = new Date(iso);
  const minutos = (d.getHours() - HORA_INICIO) * 60 + d.getMinutes();
  if (minutos < 0 || minutos > (HORA_FIM - HORA_INICIO) * 60) return null;
  return minutos;
}

interface GradeDoDiaProps {
  compromissos: CompromissoDaLista[];
  atendentes: AttendantAvailability[];
}

/**
 * Grade de horário (dia único, uma coluna por atendente) — substitui a lista
 * agrupada por dia, de pouco apelo visual e sem noção de hora. Referência
 * visual trazida pelo dono do produto (print do Zandu): grade com linhas de
 * hora e blocos coloridos — SEM o conceito de "salas" como colunas, que
 * exigiria uma tabela nova (`calendar_locations`, cortada de propósito no
 * núcleo da 0182 e nunca pedida por nenhum cliente). Colunas aqui são
 * ATENDENTE, não sala — a mesma dimensão que `owner_user_id` já modela.
 */
export function GradeDoDia({ compromissos, atendentes }: GradeDoDiaProps) {
  const cancelar = useCancelarAgendamento();
  const [alvoDoCancelamento, setAlvoDoCancelamento] = useState<CompromissoDaLista | null>(null);

  const porAtendente = new Map<string, CompromissoDaLista[]>();
  for (const c of compromissos) {
    if (c.status === "cancelled") continue; // ocupado é pending/confirmed/completed — ver STATUS_QUE_OCUPAM
    const dono = c.owner_user_id ?? "sem-dono";
    const lista = porAtendente.get(dono) ?? [];
    lista.push(c);
    porAtendente.set(dono, lista);
  }

  // Coluna por atendente da equipe (mesmo quando sem compromisso hoje — é a
  // mesma lista que já aparece no picker de "Dono do compromisso"); mais uma
  // pro caso raro de dono sem registro de disponibilidade.
  const colunas = atendentes.map((a) => ({ id: a.user_id, nome: a.name ?? a.email ?? "Sem nome" }));
  if (porAtendente.has("sem-dono")) colunas.push({ id: "sem-dono", nome: "Sem dono" });

  const horas = Array.from({ length: HORA_FIM - HORA_INICIO + 1 }, (_, i) => HORA_INICIO + i);

  async function confirmarCancelamento() {
    if (!alvoDoCancelamento) return;
    try {
      await cancelar.mutateAsync({
        id: alvoDoCancelamento.id,
        revision: alvoDoCancelamento.revision,
        reason: "Cancelado pela Agenda",
      });
      toast.success("Compromisso cancelado.");
      setAlvoDoCancelamento(null);
    } catch (err) {
      showApiError(err);
    }
  }

  if (colunas.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        Nenhum atendente com agenda configurada ainda — veja "Horário" em Equipe.
      </p>
    );
  }

  return (
    <div className="flex overflow-x-auto rounded-lg border">
      {/* Coluna das horas, fixa à esquerda */}
      <div className="flex shrink-0 flex-col border-r bg-muted/20">
        <div className="h-10 shrink-0 border-b" />
        <div className="relative" style={{ height: ALTURA_GRADE_PX }}>
          {horas.map((h, i) => (
            <div
              key={h}
              className="absolute left-0 w-14 -translate-y-1/2 pr-2 text-right text-xs text-muted-foreground"
              style={{ top: i * ALTURA_HORA_PX }}
            >
              {String(h).padStart(2, "0")}:00
            </div>
          ))}
        </div>
      </div>

      {colunas.map((coluna) => (
        <div key={coluna.id} className="min-w-[180px] flex-1 border-r last:border-r-0">
          <div className="flex h-10 shrink-0 items-center justify-center border-b px-2 text-sm font-medium">
            {coluna.nome}
          </div>
          <div className="relative" style={{ height: ALTURA_GRADE_PX }}>
            {/* Linhas de hora de fundo */}
            {horas.map((h, i) => (
              <div
                key={h}
                className="absolute inset-x-0 border-t border-border/60"
                style={{ top: i * ALTURA_HORA_PX }}
              />
            ))}

            {(porAtendente.get(coluna.id) ?? []).map((c) => {
              const inicio = minutosNaGrade(c.starts_at);
              if (inicio === null) return null;
              const duracaoMin = Math.max(
                15,
                (new Date(c.ends_at).getTime() - new Date(c.starts_at).getTime()) / 60_000,
              );
              const alturaPx = Math.max(Math.round(duracaoMin * PX_POR_MINUTO), 20);
              const cancelavel =
                c.status !== "cancelled" && c.status !== "completed" && c.status !== "no_show";

              return (
                <button
                  key={c.id}
                  type="button"
                  disabled={!cancelavel}
                  onClick={() => cancelavel && setAlvoDoCancelamento(c)}
                  className={cn(
                    // `agenda-compromisso-caixa`: a altura base é inline (varia por
                    // compromisso, Tailwind JIT não gera classe de valor
                    // interpolado em runtime) — o hover que a expande vive em
                    // globals.css com `!important`, único jeito de uma classe
                    // vencer um `style` inline no mesmo elemento.
                    "agenda-compromisso-caixa absolute left-1 right-1 overflow-hidden rounded-md border px-2 py-1 text-left text-xs leading-tight shadow-sm",
                    cancelavel ? "cursor-pointer" : "cursor-default",
                    CLASSE_POR_STATUS[c.status],
                  )}
                  style={{ top: inicio * PX_POR_MINUTO, height: alturaPx }}
                >
                  <span className="font-medium">
                    {new Date(c.starts_at).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}
                    {" · "}
                    {c.contacts?.display_name ?? c.contacts?.phone_number ?? "Sem contato"}
                  </span>
                  <br />
                  {/* Tipo de compromisso em vez do `title` cru: o default de
                      `marcarAgendamentoHandler` ("Compromisso com Fulano") só
                      repetia o nome já mostrado acima sem dizer do QUE se trata. */}
                  <span className="opacity-80">{c.calendar_event_types?.name ?? c.title}</span>
                </button>
              );
            })}
          </div>
        </div>
      ))}

      <AlertDialog open={alvoDoCancelamento !== null} onOpenChange={(v) => !v && setAlvoDoCancelamento(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancelar compromisso?</AlertDialogTitle>
            <AlertDialogDescription>
              {alvoDoCancelamento ? (
                <>
                  {alvoDoCancelamento.title} —{" "}
                  {RÓTULO_DO_STATUS[alvoDoCancelamento.status]}. O horário volta a ficar disponível
                  imediatamente. Esta ação não pode ser desfeita.
                </>
              ) : (
                "O horário volta a ficar disponível imediatamente. Esta ação não pode ser desfeita."
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Voltar</AlertDialogCancel>
            <AlertDialogAction onClick={() => void confirmarCancelamento()}>Cancelar compromisso</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
