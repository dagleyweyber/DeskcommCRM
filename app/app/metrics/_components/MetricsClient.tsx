"use client";
import { useState } from "react";

import { useAttendantMetrics, type AttendantMetric } from "@/hooks/metrics/useAttendantMetrics";
import { AtritoPanel } from "./AtritoPanel";
import { SalesDashboardPanel } from "./SalesDashboardPanel";
import { useTeamMembers } from "@/hooks/team/useTeamMembers";
import { usePipelinesList } from "@/hooks/pipelines/usePipelinesList";
import { LEAD_SOURCES } from "@/lib/leads/lead-form-shared";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const ALL = "__all__";
const ALL_PIPELINE = "__all_pipelines__";
const ALL_SOURCE = "__all_origens__";

/** yyyy-mm-dd (input date) → ISO com offset, início do dia UTC. */
function inicioDoDiaISO(data: string): string {
  return new Date(`${data}T00:00:00Z`).toISOString();
}

/** yyyy-mm-dd (input date) → ISO com offset, início do dia SEGUINTE (janela [from,to) inclui o dia inteiro). */
function fimDoDiaExclusivoISO(data: string): string {
  const d = new Date(`${data}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString();
}

function formatDuration(seconds: number | null): string {
  if (seconds == null) return "—";
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  return rest === 0 ? `${m}min` : `${m}min ${rest}s`;
}

function attendantLabel(a: AttendantMetric): string {
  return a.name ?? a.email ?? `Atendente ${a.user_id.slice(0, 8)}`;
}

interface Props {
  canCompare: boolean;
  currentUserId: string;
}

export function MetricsClient({ canCompare, currentUserId }: Props) {
  const [owner, setOwner] = useState<string>(ALL);
  const selectedOwner = owner === ALL ? null : owner;
  const { data, isLoading, isError } = useAttendantMetrics(selectedOwner);
  // Opções do filtro: só manager+ (a rota /team é manager+). Agent nem vê o filtro.
  const team = useTeamMembers({ enabled: canCompare });

  // Filtros do Dashboard de Vendas — período (todo mundo), pipeline (só
  // manager+, mesma restrição de /api/v1/pipelines) e origem (todo mundo,
  // vocabulário fixo, sem chamada de API).
  const [dataDe, setDataDe] = useState("");
  const [dataAte, setDataAte] = useState("");
  const [pipelineId, setPipelineId] = useState<string>(ALL_PIPELINE);
  const [source, setSource] = useState<string>(ALL_SOURCE);
  const pipelines = usePipelinesList({ enabled: canCompare });

  const filtrosVendas = {
    from: dataDe ? inicioDoDiaISO(dataDe) : undefined,
    to: dataAte ? fimDoDiaExclusivoISO(dataAte) : undefined,
    pipelineId: pipelineId === ALL_PIPELINE ? undefined : pipelineId,
    source: source === ALL_SOURCE ? undefined : source,
  };

  if (isLoading) return <p className="text-sm text-muted-foreground">Carregando…</p>;
  if (isError || !data) return <p className="text-sm text-destructive">Erro ao carregar métricas.</p>;

  const metrics = data.data;
  const funnelTotal = metrics.funnel.reduce((acc, s) => acc + s.count, 0);
  const maxCount = Math.max(1, ...metrics.funnel.map((s) => s.count));

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end gap-3">
        {canCompare ? (
          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">Atendente</span>
            <Select value={owner} onValueChange={setOwner}>
              <SelectTrigger className="w-56">
                <SelectValue placeholder="Todos os atendentes" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>Todos os atendentes</SelectItem>
                {(team.data?.data ?? [])
                  .filter((m) => m.role !== "viewer")
                  .map((m) => (
                    <SelectItem key={m.user_id} value={m.user_id}>
                      {m.full_name ?? m.email ?? m.user_id.slice(0, 8)}
                      {m.user_id === currentUserId ? " (você)" : ""}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>
        ) : null}

        <div className="flex flex-col gap-1">
          <Label htmlFor="vendas-de" className="text-xs text-muted-foreground">
            De
          </Label>
          <Input
            id="vendas-de"
            type="date"
            className="w-40"
            value={dataDe}
            onChange={(e) => setDataDe(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="vendas-ate" className="text-xs text-muted-foreground">
            Até
          </Label>
          <Input
            id="vendas-ate"
            type="date"
            className="w-40"
            value={dataAte}
            onChange={(e) => setDataAte(e.target.value)}
          />
        </div>

        {canCompare ? (
          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">Pipeline</span>
            <Select value={pipelineId} onValueChange={setPipelineId}>
              <SelectTrigger className="w-56">
                <SelectValue placeholder="Todos os pipelines" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_PIPELINE}>Todos os pipelines</SelectItem>
                {(pipelines.data?.data ?? []).map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : null}

        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Origem</span>
          <Select value={source} onValueChange={setSource}>
            <SelectTrigger className="w-56">
              <SelectValue placeholder="Todas as origens" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_SOURCE}>Todas as origens</SelectItem>
              {LEAD_SOURCES.map((s) => (
                <SelectItem key={s.value} value={s.value}>
                  {s.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Dashboard de Vendas: KPIs + gráficos com dado que já existe
          (value_cents, closed_at, created_at, status, source). Filtrado por
          período/pipeline/origem da linha acima — não por atendente, igual ao
          Atrito (visão do negócio inteiro no período, não de uma pessoa). */}
      <div className="flex flex-col gap-3">
        <h2 className="text-base font-medium">Vendas</h2>
        <SalesDashboardPanel filtros={filtrosVendas} />
      </div>

      {/* Acima do funil e da performance de propósito: é o número do sistema
          inteiro, ao qual as métricas de área se subordinam (doutrina §3.6).
          Não filtra por atendente — atrito é propriedade do sistema, e quebrá-lo
          por pessoa convida a otimização local que degrada o todo. */}
      <AtritoPanel podeEditarRegua={canCompare} />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Funil {selectedOwner ? "do atendente" : ""} · {funnelTotal}{" "}
            {funnelTotal === 1 ? "aberto" : "abertos"}
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {metrics.funnel.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nenhuma etapa configurada.</p>
          ) : (
            metrics.funnel.map((s) => (
              <div key={s.stage_id} className="flex items-center gap-3">
                <span className="w-40 shrink-0 truncate text-sm">{s.stage_name}</span>
                <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-primary transition-[width]"
                    style={{ width: `${(s.count / maxCount) * 100}%` }}
                  />
                </div>
                <span className="w-8 shrink-0 text-right text-sm tabular-nums">{s.count}</span>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {canCompare ? "Performance por atendente" : "Sua performance"}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {metrics.attendants.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Sem atividade no período (ganhos/perdidos, conversas ou respostas).
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Atendente</TableHead>
                  <TableHead className="text-right">Ganhos</TableHead>
                  <TableHead className="text-right">Perdidos</TableHead>
                  <TableHead className="text-right">Conversas</TableHead>
                  <TableHead className="text-right">1ª resposta (média)</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {metrics.attendants.map((a) => (
                  <TableRow key={a.user_id}>
                    <TableCell className="font-medium">
                      {attendantLabel(a)}
                      {a.user_id === currentUserId ? (
                        <span className="text-muted-foreground"> (você)</span>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{a.won}</TableCell>
                    <TableCell className="text-right tabular-nums">{a.lost}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {a.conversations_handled}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatDuration(a.avg_first_response_seconds)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
