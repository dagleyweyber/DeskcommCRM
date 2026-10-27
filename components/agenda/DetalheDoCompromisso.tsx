"use client";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import { useAlterarAgendamento, useCancelarAgendamento, type CompromissoDaLista } from "@/hooks/agenda/useAgendamentos";
import { minutosNoDia, minutosParaHhmm } from "@/lib/agenda/grade";
import { RÓTULO_DO_STATUS, type StatusDoCompromisso } from "@/lib/agenda/tipos";
import { cn } from "@/lib/utils";

import { CLASSE_DO_SELO } from "./status";

interface DetalheDoCompromissoProps {
  compromisso: CompromissoDaLista | null;
  timezone: string;
  nomeDaSala: (roomId: string | null) => string;
  nomeDoProfissional: (userId: string | null) => string | null;
  onFechar: () => void;
  onEditar: (c: CompromissoDaLista) => void;
}

/** Os status que a recepção marca com um clique — na ordem do dia do cliente. */
const ACOES_DE_STATUS: { status: StatusDoCompromisso; rotulo: string }[] = [
  { status: "pending", rotulo: "Agendado" },
  { status: "confirmed", rotulo: "Confirmado" },
  { status: "declined", rotulo: "Não confirmado" },
  { status: "completed", rotulo: "Compareceu" },
  { status: "no_show", rotulo: "Faltou" },
];

/**
 * O que abre ao clicar num compromisso da grade: ver os dados, trocar o
 * status com um clique, editar/remarcar ou cancelar (com motivo — fica no
 * histórico e libera o horário).
 */
export function DetalheDoCompromisso({
  compromisso,
  timezone,
  nomeDaSala,
  nomeDoProfissional,
  onFechar,
  onEditar,
}: DetalheDoCompromissoProps) {
  const alterar = useAlterarAgendamento();
  const cancelar = useCancelarAgendamento();
  const [cancelando, setCancelando] = useState(false);
  const [motivo, setMotivo] = useState("");

  if (!compromisso) return null;
  const c = compromisso;
  const encerrado = c.status === "cancelled";

  async function mudarStatus(status: StatusDoCompromisso) {
    if (status === c.status) return;
    try {
      await alterar.mutateAsync({ id: c.id, input: { revision: c.revision, status: status as Exclude<StatusDoCompromisso, "cancelled"> } });
      toast.success(`Marcado como "${RÓTULO_DO_STATUS[status]}".`);
      onFechar();
    } catch (err) {
      showApiError(err);
    }
  }

  async function confirmarCancelamento() {
    try {
      await cancelar.mutateAsync({ id: c.id, revision: c.revision, reason: motivo.trim() || "Cancelado pela Agenda" });
      toast.success("Compromisso cancelado. O horário foi liberado.");
      setCancelando(false);
      setMotivo("");
      onFechar();
    } catch (err) {
      showApiError(err);
    }
  }

  const inicio = minutosNoDia(c.starts_at, timezone);
  const fim = minutosNoDia(c.ends_at, timezone);
  const dia = new Date(c.starts_at).toLocaleDateString("pt-BR", {
    weekday: "long",
    day: "2-digit",
    month: "long",
    timeZone: timezone,
  });
  const profissional = nomeDoProfissional(c.owner_user_id);

  return (
    <Dialog
      open
      onOpenChange={(v) => {
        if (!v) {
          setCancelando(false);
          onFechar();
        }
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="pr-6">{c.contacts?.display_name ?? c.contacts?.phone_number ?? "Sem contato"}</DialogTitle>
          <DialogDescription className="capitalize">
            {dia} · {minutosParaHhmm(inicio)}–{minutosParaHhmm(fim)}
          </DialogDescription>
        </DialogHeader>

        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
          <dt className="text-muted-foreground">Status</dt>
          <dd>
            <span className={cn("rounded px-2 py-0.5 text-xs font-medium", CLASSE_DO_SELO[c.status])}>{RÓTULO_DO_STATUS[c.status]}</span>
            {c.client_responded_at && (c.status === "confirmed" || c.status === "declined") && (
              <span className="ml-2 text-xs text-muted-foreground">
                respondido pelo cliente no WhatsApp em{" "}
                {new Date(c.client_responded_at).toLocaleString("pt-BR", { timeZone: timezone, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}
              </span>
            )}
          </dd>
          <dt className="text-muted-foreground">Serviço</dt>
          <dd>{c.calendar_event_types?.name ?? c.title}</dd>
          <dt className="text-muted-foreground">Sala</dt>
          <dd>{nomeDaSala(c.room_id)}</dd>
          <dt className="text-muted-foreground">Profissional</dt>
          <dd>{profissional ?? "—"}</dd>
          {c.contacts?.phone_number && (
            <>
              <dt className="text-muted-foreground">Telefone</dt>
              <dd>{c.contacts.phone_number}</dd>
            </>
          )}
          {c.notes && (
            <>
              <dt className="text-muted-foreground">Observação</dt>
              <dd className="whitespace-pre-wrap">{c.notes}</dd>
            </>
          )}
        </dl>

        {!encerrado && !cancelando && (
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground">Marcar como</p>
            <div className="flex flex-wrap gap-2">
              {ACOES_DE_STATUS.map((a) => (
                <Button
                  key={a.status}
                  size="sm"
                  variant={a.status === c.status ? "default" : "outline"}
                  disabled={alterar.isPending}
                  onClick={() => void mudarStatus(a.status)}
                >
                  {a.rotulo}
                </Button>
              ))}
            </div>
          </div>
        )}

        {cancelando && (
          <div className="space-y-2 rounded-md border border-destructive/40 p-3">
            <Label htmlFor="motivo-cancelamento">Motivo do cancelamento</Label>
            <Input
              id="motivo-cancelamento"
              autoFocus
              placeholder="Ex.: cliente pediu para desmarcar"
              value={motivo}
              onChange={(e) => setMotivo(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">O horário volta a ficar livre na hora.</p>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setCancelando(false)}>
                Voltar
              </Button>
              <Button variant="destructive" size="sm" disabled={cancelar.isPending} onClick={() => void confirmarCancelamento()}>
                Cancelar compromisso
              </Button>
            </div>
          </div>
        )}

        {!encerrado && !cancelando && (
          <DialogFooter className="gap-2 sm:justify-between sm:gap-0">
            <Button variant="ghost" className="text-destructive hover:text-destructive" onClick={() => setCancelando(true)}>
              Cancelar compromisso
            </Button>
            <Button onClick={() => onEditar(c)}>Editar / remarcar</Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
