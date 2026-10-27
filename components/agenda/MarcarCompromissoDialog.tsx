"use client";
import { CalendarDays } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import { apiClient } from "@/lib/api/client";
import { dataNoFuso, minutosNoDia, minutosParaHhmm } from "@/lib/agenda/grade";
import { dataLocalDe } from "@/lib/agenda/fuso";
import type { HorarioLivre } from "@/lib/agenda/tipos";
import { useAttendants } from "@/hooks/team/useAttendants";
import { useEventTypes } from "@/hooks/agenda/useEventTypes";
import { useHorariosLivres } from "@/hooks/agenda/useHorariosLivres";
import { useSalas } from "@/hooks/agenda/useSalas";
import { useAlterarAgendamento, useMarcarAgendamento, type CompromissoDaLista } from "@/hooks/agenda/useAgendamentos";
import { cn } from "@/lib/utils";

import { MiniCalendario } from "./MiniCalendario";

interface ContatoEncontrado {
  id: string;
  display_name: string | null;
  phone_number: string | null;
}

const QUALQUER_SALA = "__qualquer__";
const NINGUEM = "__ninguem__";

interface MarcarCompromissoDialogProps {
  onMarcado?: () => void;
  /**
   * Modo "contato travado" (Kanban → Agenda): quando o compromisso nasce de um
   * negócio específico, o contato não é escolhido — já é o do lead.
   */
  contatoFixo?: ContatoEncontrado;
  /** Pré-preenchimento ao clicar num horário vazio da grade. */
  inicial?: { roomId?: string | null; data?: string | null; hhmm?: string | null };
  /** Modo EDIÇÃO: muda dia/hora/serviço (remarca), sala, profissional, observação. */
  compromisso?: CompromissoDaLista | null;
  /** Customiza o botão que abre o diálogo — default é "Agendar". */
  trigger?: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

/**
 * Agendar e editar compromisso — um diálogo só (serviço → cliente → dia no
 * calendário → sala → horário livre → profissional opcional).
 *
 * Os horários vêm de `GET /agenda/horarios-livres` com o DIA escolhido — o
 * mesmo `lib/agenda/consulta.ts` que o servidor reconfere e que a IA usa: só
 * aparece o que está livre de verdade. A versão anterior listava os 30
 * primeiros horários da janela inteira, o que na prática limitava a agenda a
 * ~3 dias (achado do dono do produto: sessão de laser a cada 45 dias não
 * cabia).
 *
 * Reaproveitado pelo Kanban (`ScheduleMeetingDialog`) via `contatoFixo` —
 * marcar pelo negócio cria o mesmo `calendar_appointments` que a Agenda.
 */
export function MarcarCompromissoDialog({
  onMarcado,
  contatoFixo,
  inicial,
  compromisso,
  trigger,
  open: openControlado,
  onOpenChange: onOpenChangeControlado,
}: MarcarCompromissoDialogProps) {
  const editando = Boolean(compromisso);
  const [abertoInterno, setAbertoInterno] = useState(false);
  const aberto = openControlado ?? abertoInterno;
  const setAberto = onOpenChangeControlado ?? setAbertoInterno;

  const { data: tipos } = useEventTypes();
  const { data: dadosDasSalas } = useSalas();
  const { data: atendentes } = useAttendants();
  const marcar = useMarcarAgendamento();
  const alterar = useAlterarAgendamento();

  const tz = dadosDasSalas?.horario_padrao.timezone ?? "America/Sao_Paulo";
  // Relógio lido UMA vez (inicializador de estado), não a cada render.
  const [montadoEm] = useState(() => new Date());
  const hoje = dataLocalDe(montadoEm, tz);

  const [eventTypeId, setEventTypeId] = useState("");
  const [contato, setContato] = useState<ContatoEncontrado | null>(contatoFixo ?? null);
  const [termoBusca, setTermoBusca] = useState("");
  const [contatos, setContatos] = useState<ContatoEncontrado[]>([]);
  const [buscando, setBuscando] = useState(false);
  const [data, setData] = useState(hoje);
  const [salaEscolhida, setSalaEscolhida] = useState(QUALQUER_SALA);
  const [horario, setHorario] = useState<HorarioLivre | null>(null);
  const [horaDesejada, setHoraDesejada] = useState<string | null>(null);
  const [profissional, setProfissional] = useState(NINGUEM);
  const [observacao, setObservacao] = useState("");
  const [calendarioAberto, setCalendarioAberto] = useState(false);

  // Cada abertura começa do estado certo: o compromisso em edição, o horário
  // clicado na grade, ou vazio.
  useEffect(() => {
    if (!aberto) return;
    if (compromisso) {
      setEventTypeId(compromisso.event_type_id ?? "");
      setContato({
        id: compromisso.contact_id,
        display_name: compromisso.contacts?.display_name ?? null,
        phone_number: compromisso.contacts?.phone_number ?? null,
      });
      setData(dataNoFuso(compromisso.starts_at, tz));
      setSalaEscolhida(compromisso.room_id ?? QUALQUER_SALA);
      setHoraDesejada(minutosParaHhmm(minutosNoDia(compromisso.starts_at, tz)));
      setProfissional(compromisso.owner_user_id ?? NINGUEM);
      setObservacao(compromisso.notes ?? "");
    } else {
      setEventTypeId("");
      setContato(contatoFixo ?? null);
      setData(inicial?.data ?? hoje);
      setSalaEscolhida(inicial?.roomId ?? QUALQUER_SALA);
      setHoraDesejada(inicial?.hhmm ?? null);
      setProfissional(NINGUEM);
      setObservacao("");
    }
    setHorario(null);
    setTermoBusca("");
    setContatos([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reinicia só ao ABRIR
  }, [aberto]);

  const tipo = (tipos ?? []).find((t) => t.id === eventTypeId) ?? null;
  const salasDoServico = useMemo(() => {
    const todas = dadosDasSalas?.salas ?? [];
    const permitidas = tipo?.room_ids ?? [];
    return permitidas.length === 0 ? todas : todas.filter((s) => permitidas.includes(s.id));
  }, [dadosDasSalas, tipo]);

  // Sala pré-escolhida que não atende o serviço volta para "qualquer sala".
  useEffect(() => {
    if (salaEscolhida !== QUALQUER_SALA && tipo && !salasDoServico.some((s) => s.id === salaEscolhida)) {
      setSalaEscolhida(QUALQUER_SALA);
    }
  }, [salaEscolhida, salasDoServico, tipo]);

  const { data: horarios, isLoading: carregandoHorarios } = useHorariosLivres(eventTypeId || null, {
    roomId: salaEscolhida === QUALQUER_SALA ? null : salaEscolhida,
    data,
    ignorarId: compromisso?.id ?? null,
  });

  // O horário clicado na grade (ou o do compromisso em edição) vira a escolha
  // assim que a lista chega — se ainda estiver livre.
  useEffect(() => {
    if (!horarios) return;
    if (horario && horarios.some((h) => h.starts_at === horario.starts_at && h.room_id === horario.room_id)) return;
    const desejado = horaDesejada ? horarios.find((h) => minutosParaHhmm(minutosNoDia(h.starts_at, tz)) === horaDesejada) : undefined;
    setHorario(desejado ?? null);
  }, [horarios, horaDesejada, horario, tz]);

  const porPeriodo = useMemo(() => {
    const grupos: { titulo: string; itens: HorarioLivre[] }[] = [
      { titulo: "Manhã", itens: [] },
      { titulo: "Tarde", itens: [] },
      { titulo: "Noite", itens: [] },
    ];
    for (const h of horarios ?? []) {
      const min = minutosNoDia(h.starts_at, tz);
      grupos[min < 12 * 60 ? 0 : min < 18 * 60 ? 1 : 2]!.itens.push(h);
    }
    return grupos.filter((g) => g.itens.length > 0);
  }, [horarios, tz]);

  async function buscarContatos(termo: string) {
    setTermoBusca(termo);
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

  async function confirmar() {
    if (!eventTypeId || !contato || !horario) return;
    const ownerUserId = profissional === NINGUEM ? null : profissional;
    const notes = observacao.trim() ? observacao.trim() : null;
    try {
      if (compromisso) {
        const mesmoHorario = new Date(horario.starts_at).getTime() === new Date(compromisso.starts_at).getTime();
        await alterar.mutateAsync({
          id: compromisso.id,
          input: {
            revision: compromisso.revision,
            ...(mesmoHorario ? {} : { starts_at: horario.starts_at }),
            ...(eventTypeId !== compromisso.event_type_id ? { event_type_id: eventTypeId } : {}),
            ...(horario.room_id !== compromisso.room_id ? { room_id: horario.room_id } : {}),
            owner_user_id: ownerUserId,
            notes,
          },
        });
        toast.success("Compromisso atualizado.");
      } else {
        await marcar.mutateAsync({
          event_type_id: eventTypeId,
          contact_id: contato.id,
          starts_at: horario.starts_at,
          room_id: horario.room_id,
          owner_user_id: ownerUserId,
          notes,
        });
        toast.success("Agendado!");
      }
      setAberto(false);
      onMarcado?.();
    } catch (err) {
      showApiError(err);
    }
  }

  const salvando = marcar.isPending || alterar.isPending;
  const rotuloDoDia = new Date(`${data}T12:00:00Z`).toLocaleDateString("pt-BR", {
    weekday: "long",
    day: "2-digit",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });

  return (
    <Dialog open={aberto} onOpenChange={setAberto}>
      {openControlado === undefined && <DialogTrigger asChild>{trigger ?? <Button>Agendar</Button>}</DialogTrigger>}
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{editando ? "Editar compromisso" : "Agendar"}</DialogTitle>
          <DialogDescription>
            {editando
              ? "Mudar o dia, a hora ou o serviço remarca o compromisso (o anterior fica no histórico)."
              : "Só aparecem horários realmente livres."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Serviço</Label>
            <Select
              value={eventTypeId}
              onValueChange={(v) => {
                setEventTypeId(v);
                setHorario(null);
              }}
            >
              <SelectTrigger>
                <SelectValue placeholder="Escolha o serviço" />
              </SelectTrigger>
              <SelectContent>
                {(tipos ?? []).map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.name} ({t.duration_minutes}min)
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {(tipos ?? []).length === 0 && (
              <p className="text-xs text-muted-foreground">Nenhum serviço cadastrado — crie em Configurações → Agenda.</p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label>Cliente</Label>
            {contato ? (
              <div className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
                <span>
                  {contato.display_name ?? contato.phone_number ?? "Sem nome"}
                  {contato.phone_number && contato.display_name ? (
                    <span className="text-muted-foreground"> · {contato.phone_number}</span>
                  ) : null}
                </span>
                {!contatoFixo && !editando && (
                  <Button variant="ghost" size="sm" onClick={() => setContato(null)}>
                    Trocar
                  </Button>
                )}
              </div>
            ) : (
              <>
                <Input
                  autoFocus
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

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Dia</Label>
              <Popover open={calendarioAberto} onOpenChange={setCalendarioAberto}>
                <PopoverTrigger asChild>
                  <Button variant="outline" className="w-full justify-start font-normal capitalize">
                    <CalendarDays className="mr-2 h-4 w-4 shrink-0" />
                    <span className="truncate">{rotuloDoDia}</span>
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-72 p-3" align="start">
                  <MiniCalendario
                    valor={data}
                    hoje={hoje}
                    minimo={hoje}
                    onSelecionar={(d) => {
                      setData(d);
                      setHorario(null);
                      setCalendarioAberto(false);
                    }}
                  />
                </PopoverContent>
              </Popover>
            </div>

            <div className="space-y-1.5">
              <Label>Sala</Label>
              <Select
                value={salaEscolhida}
                onValueChange={(v) => {
                  setSalaEscolhida(v);
                  setHorario(null);
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={QUALQUER_SALA}>Qualquer sala livre</SelectItem>
                  {salasDoServico.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {eventTypeId && (
            <div className="space-y-1.5">
              <Label>Horário</Label>
              {carregandoHorarios ? (
                <p className="text-xs text-muted-foreground">Calculando horários livres…</p>
              ) : porPeriodo.length === 0 ? (
                <p className="rounded-md border border-dashed px-3 py-4 text-center text-sm text-muted-foreground">
                  Nenhum horário livre neste dia. Escolha outro dia{salaEscolhida !== QUALQUER_SALA ? " ou outra sala" : ""}.
                </p>
              ) : (
                <div className="max-h-56 space-y-3 overflow-y-auto pr-1">
                  {porPeriodo.map((grupo) => (
                    <div key={grupo.titulo}>
                      <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{grupo.titulo}</p>
                      <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                        {grupo.itens.map((h) => {
                          const escolhido = horario?.starts_at === h.starts_at && horario.room_id === h.room_id;
                          return (
                            <Button
                              key={`${h.starts_at}-${h.room_id}`}
                              type="button"
                              size="sm"
                              variant={escolhido ? "default" : "outline"}
                              className={cn("h-auto flex-col py-1.5", escolhido && "ring-2 ring-primary/40")}
                              onClick={() => setHorario(h)}
                            >
                              <span className="tabular-nums">{minutosParaHhmm(minutosNoDia(h.starts_at, tz))}</span>
                              {salaEscolhida === QUALQUER_SALA && (
                                <span className="max-w-full truncate text-[10px] font-normal opacity-80">{h.room_name}</span>
                              )}
                            </Button>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="space-y-1.5">
            <Label>
              Profissional <span className="font-normal text-muted-foreground">(opcional)</span>
            </Label>
            <Select value={profissional} onValueChange={setProfissional}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NINGUEM}>Não definir</SelectItem>
                {(atendentes?.data ?? []).map((a) => (
                  <SelectItem key={a.user_id} value={a.user_id}>
                    {a.name ?? a.email ?? "Sem nome"}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label>
              Observação <span className="font-normal text-muted-foreground">(opcional)</span>
            </Label>
            <Textarea rows={2} value={observacao} maxLength={2000} onChange={(e) => setObservacao(e.target.value)} />
          </div>
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          {horario && (
            <p className="mr-auto self-center text-xs text-muted-foreground">
              {minutosParaHhmm(minutosNoDia(horario.starts_at, tz))} · {horario.room_name}
            </p>
          )}
          <Button disabled={!eventTypeId || !contato || !horario || salvando} onClick={() => void confirmar()}>
            {salvando ? "Salvando…" : editando ? "Salvar" : "Confirmar agendamento"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
