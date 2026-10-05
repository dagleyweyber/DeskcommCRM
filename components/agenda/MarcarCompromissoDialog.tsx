"use client";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { apiClient } from "@/lib/api/client";
import { useEventTypes } from "@/hooks/agenda/useEventTypes";
import { useHorariosLivres } from "@/hooks/agenda/useHorariosLivres";
import { useMarcarAgendamento } from "@/hooks/agenda/useAgendamentos";
import { showApiError } from "@/components/feedback/ApiErrorToast";

interface ContatoEncontrado {
  id: string;
  display_name: string | null;
  phone_number: string | null;
}

/**
 * Marca um compromisso: tipo → contato → horário livre. O horário mostrado
 * é o MESMO que `lib/agenda/consulta.ts` publica pra IA — nunca inventa.
 *
 * Fase 1 — não arrasta: a remarcação por drag-and-drop do upstream é código
 * próprio e complexo (ver plano desta feature); aqui reabrir este MESMO
 * diálogo com `appointmentId` preenchido cobre o reagendamento sem herdar
 * aquela complexidade.
 */
export function MarcarCompromissoDialog({ onMarcado }: { onMarcado?: () => void }) {
  const [aberto, setAberto] = useState(false);
  const [eventTypeId, setEventTypeId] = useState<string>("");
  const [termoBusca, setTermoBusca] = useState("");
  const [contatos, setContatos] = useState<ContatoEncontrado[]>([]);
  const [contato, setContato] = useState<ContatoEncontrado | null>(null);
  const [horarioEscolhido, setHorarioEscolhido] = useState<string | null>(null);
  const [buscando, setBuscando] = useState(false);

  const { data: tipos } = useEventTypes();
  const { data: horarios, isLoading: carregandoHorarios } = useHorariosLivres(eventTypeId || null);
  const marcar = useMarcarAgendamento();

  async function buscarContatos(termo: string) {
    setTermoBusca(termo);
    setContato(null);
    if (termo.trim().length < 2) {
      setContatos([]);
      return;
    }
    setBuscando(true);
    try {
      const r = await apiClient.get<{ data: ContatoEncontrado[] }>(
        `/api/v1/contacts?search=${encodeURIComponent(termo)}&limit=8`,
      );
      setContatos(r.data);
    } catch {
      setContatos([]);
    } finally {
      setBuscando(false);
    }
  }

  function reiniciar() {
    setEventTypeId("");
    setTermoBusca("");
    setContatos([]);
    setContato(null);
    setHorarioEscolhido(null);
  }

  async function confirmar() {
    if (!eventTypeId || !contato || !horarioEscolhido) return;
    try {
      await marcar.mutateAsync({ event_type_id: eventTypeId, contact_id: contato.id, starts_at: horarioEscolhido });
      toast.success("Compromisso marcado.");
      setAberto(false);
      reiniciar();
      onMarcado?.();
    } catch (err) {
      showApiError(err);
    }
  }

  return (
    <Dialog
      open={aberto}
      onOpenChange={(v) => {
        setAberto(v);
        if (!v) reiniciar();
      }}
    >
      <DialogTrigger asChild>
        <Button>Marcar compromisso</Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Marcar compromisso</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Tipo de compromisso</Label>
            <Select
              value={eventTypeId}
              onValueChange={(v) => {
                setEventTypeId(v);
                setHorarioEscolhido(null);
              }}
            >
              <SelectTrigger>
                <SelectValue placeholder="Escolha um tipo" />
              </SelectTrigger>
              <SelectContent>
                {(tipos ?? []).map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.name} ({t.duration_minutes}min)
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label>Contato</Label>
            {contato ? (
              <div className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
                <span>{contato.display_name ?? contato.phone_number ?? "Sem nome"}</span>
                <Button variant="ghost" size="sm" onClick={() => setContato(null)}>
                  Trocar
                </Button>
              </div>
            ) : (
              <>
                <Input
                  placeholder="Buscar por nome ou telefone…"
                  value={termoBusca}
                  onChange={(e) => void buscarContatos(e.target.value)}
                />
                {buscando && <p className="text-xs text-muted-foreground">Buscando…</p>}
                {contatos.length > 0 && (
                  <ul className="max-h-40 overflow-y-auto rounded-md border">
                    {contatos.map((c) => (
                      <li key={c.id}>
                        <button
                          type="button"
                          className="w-full px-3 py-2 text-left text-sm hover:bg-accent"
                          onClick={() => {
                            setContato(c);
                            setContatos([]);
                          }}
                        >
                          {c.display_name ?? "Sem nome"}
                          {c.phone_number ? <span className="text-muted-foreground"> · {c.phone_number}</span> : null}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </div>

          {eventTypeId && (
            <div className="space-y-1.5">
              <Label>Horário</Label>
              {carregandoHorarios ? (
                <p className="text-xs text-muted-foreground">Calculando horários livres…</p>
              ) : (horarios ?? []).length === 0 ? (
                <p className="text-xs text-muted-foreground">Nenhum horário livre na janela de agendamento deste tipo.</p>
              ) : (
                <div className="grid max-h-48 grid-cols-2 gap-2 overflow-y-auto">
                  {(horarios ?? []).slice(0, 30).map((h) => (
                    <Button
                      key={h.starts_at}
                      type="button"
                      variant={horarioEscolhido === h.starts_at ? "default" : "outline"}
                      size="sm"
                      onClick={() => setHorarioEscolhido(h.starts_at)}
                    >
                      {new Date(h.starts_at).toLocaleString("pt-BR", { weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}
                    </Button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            disabled={!eventTypeId || !contato || !horarioEscolhido || marcar.isPending}
            onClick={() => void confirmar()}
          >
            {marcar.isPending ? "Marcando…" : "Confirmar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
