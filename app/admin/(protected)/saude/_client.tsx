"use client";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import type { Saude, SaudeDaClinica } from "@/lib/admin/saude-das-clinicas";
import { useSaudeDasClinicas } from "@/hooks/useSaudeDasClinicas";

const ROTULO: Record<Saude, string> = {
  critico: "Crítico",
  atencao: "Atenção",
  ok: "OK",
  suspenso: "Suspensa",
};

/** Cor só onde ela decide algo — o resto é neutro, senão nada se destaca. */
const COR_PASTILHA: Record<Saude, string> = {
  critico: "bg-destructive/15 text-destructive border-destructive/30",
  atencao: "bg-warning/15 text-warning-fg border-warning/30",
  ok: "bg-muted text-muted-foreground border-transparent",
  suspenso: "bg-muted text-muted-foreground border-transparent",
};

function Pastilha({ saude, texto }: { saude: Saude; texto: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-xs whitespace-nowrap",
        COR_PASTILHA[saude],
      )}
    >
      {texto}
    </span>
  );
}

function Celula({ sinal }: { sinal: { saude: Saude; detalhe: string } }) {
  // Sinal saudável fica discreto: o olho tem que cair no que está quebrado.
  if (sinal.saude === "ok") {
    return <span className="text-xs text-muted-foreground">{sinal.detalhe}</span>;
  }
  return <Pastilha saude={sinal.saude} texto={sinal.detalhe} />;
}

function tempoRelativo(iso: string | null): string {
  if (!iso) return "—";
  const minutos = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutos < 1) return "agora";
  if (minutos < 60) return `há ${minutos}min`;
  const horas = Math.floor(minutos / 60);
  if (horas < 24) return `há ${horas}h`;
  return `há ${Math.floor(horas / 24)}d`;
}

function LinhaDaClinica({ clinica }: { clinica: SaudeDaClinica }) {
  return (
    <tr className="border-b last:border-0">
      <td className="px-3 py-2.5">
        <div className="flex items-center gap-2">
          <Pastilha saude={clinica.geral} texto={ROTULO[clinica.geral]} />
          <Link
            href={`/admin/tenants/${clinica.organization_id}/health`}
            className="text-sm font-medium hover:underline"
          >
            {clinica.display_name}
          </Link>
        </div>
      </td>
      <td className="px-3 py-2.5">
        <Celula sinal={clinica.canal} />
      </td>
      <td className="px-3 py-2.5">
        <Celula sinal={clinica.ia} />
      </td>
      <td className="px-3 py-2.5">
        <Celula sinal={clinica.fila} />
      </td>
      <td className="px-3 py-2.5">
        <Celula sinal={clinica.mensagens} />
      </td>
      <td className="px-3 py-2.5">
        <Celula sinal={clinica.avisos} />
      </td>
      <td className="px-3 py-2.5 text-xs whitespace-nowrap text-muted-foreground">
        {tempoRelativo(clinica.ultima_mensagem_at)}
      </td>
    </tr>
  );
}

export function SaudeDasClinicasClient() {
  const { data, isLoading, isFetching, isError, error, refetch } = useSaudeDasClinicas();

  return (
    <div className="flex flex-col gap-5 p-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Saúde das clínicas</h1>
          <p className="text-sm text-muted-foreground">
            Todas as organizações numa consulta só. Pior primeiro — quem precisa de socorro
            aparece no topo.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {data && (
            <span className="text-xs text-muted-foreground">
              Apurado {tempoRelativo(data.apurado_em)}
            </span>
          )}
          <Button variant="outline" size="sm" disabled={isFetching} onClick={() => void refetch()}>
            {isFetching ? "Atualizando…" : "Atualizar"}
          </Button>
        </div>
      </header>

      {data && (
        <div className="flex flex-wrap gap-2">
          <Pastilha saude="critico" texto={`${data.resumo.critico} crítico(s)`} />
          <Pastilha saude="atencao" texto={`${data.resumo.atencao} em atenção`} />
          <Pastilha saude="ok" texto={`${data.resumo.ok} ok`} />
          {data.resumo.suspenso > 0 && (
            <Pastilha saude="suspenso" texto={`${data.resumo.suspenso} suspensa(s)`} />
          )}
        </div>
      )}

      {isError && (
        <div
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          Não foi possível carregar a saúde das clínicas
          {error instanceof Error ? `: ${error.message}` : "."}
        </div>
      )}

      {isLoading ? (
        <div className="flex flex-col gap-2">
          {[0, 1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-11 w-full" />
          ))}
        </div>
      ) : data && data.clinicas.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nenhuma organização cadastrada ainda.</p>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full min-w-[780px] table-auto text-left">
            <thead className="border-b bg-muted/40">
              <tr className="text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-3 py-2 font-medium">Clínica</th>
                <th className="px-3 py-2 font-medium">Canal</th>
                <th className="px-3 py-2 font-medium">IA</th>
                <th className="px-3 py-2 font-medium">Fila</th>
                <th className="px-3 py-2 font-medium">Mensagens</th>
                <th className="px-3 py-2 font-medium">Avisos</th>
                <th className="px-3 py-2 font-medium">Última msg</th>
              </tr>
            </thead>
            <tbody>
              {(data?.clinicas ?? []).map((c) => (
                <LinhaDaClinica key={c.organization_id} clinica={c} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
