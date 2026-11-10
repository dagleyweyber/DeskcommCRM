"use client";
/**
 * O resultado de UMA campanha, aberto pelo botão "Ver resultados" do cartão: aceitas pela Meta,
 * entregues, lidas, respostas, saídas e cliques, e as falhas agrupadas por motivo.
 *
 * Os percentuais são sobre quem RECEBEU (entregues) — é a régua que a Meta usa para a qualidade.
 */
import { useResultadoDaCampanha } from "@/hooks/campaigns/useCampaigns";

function pct(parte: number, base: number): string | null {
  if (base <= 0) return null;
  return `${((parte / base) * 100).toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%`;
}

function Numero({
  rotulo,
  valor,
  detalhe,
  alerta,
  testId,
}: {
  rotulo: string;
  valor: number | null;
  detalhe?: string | null;
  alerta?: boolean;
  testId: string;
}) {
  return (
    <div className="flex flex-col rounded-md border border-border p-3" data-testid={testId}>
      <span className="text-xs text-muted-foreground">{rotulo}</span>
      <span className={`text-lg font-semibold tabular-nums ${alerta ? "text-destructive" : ""}`}>
        {valor === null ? "—" : valor.toLocaleString("pt-BR")}
      </span>
      {detalhe && <span className="text-xs text-muted-foreground">{detalhe}</span>}
    </div>
  );
}

export function PainelDaCampanha({ campanhaId, andando }: { campanhaId: string; andando: boolean }) {
  const { data, isPending, isError } = useResultadoDaCampanha(campanhaId, true, andando);

  if (isPending) return <p className="text-sm text-muted-foreground">Calculando resultado…</p>;
  if (isError || !data) return <p className="text-sm text-destructive">Não foi possível carregar o resultado agora.</p>;

  const r = data.data;
  const semEntrega = r.aceitas > 0 && r.entregues === 0;
  const taxaDeSaida = r.entregues > 0 ? r.saidas / r.entregues : 0;

  return (
    <div className="flex flex-col gap-3" data-testid="painel-da-campanha">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-7">
        <Numero rotulo="Aceitas pela Meta" valor={r.aceitas} detalhe={`de ${r.total.toLocaleString("pt-BR")}`} testId="painel-aceitas" />
        <Numero rotulo="Entregues" valor={r.entregues} detalhe={pct(r.entregues, r.aceitas)} testId="painel-entregues" />
        <Numero rotulo="Lidas" valor={r.lidas} detalhe={pct(r.lidas, r.entregues)} testId="painel-lidas" />
        <Numero rotulo="Responderam" valor={r.respostas} detalhe={pct(r.respostas, r.entregues)} testId="painel-respostas" />
        <Numero
          rotulo="Pediram para sair"
          valor={r.saidas}
          detalhe={pct(r.saidas, r.entregues)}
          alerta={taxaDeSaida >= 0.02}
          testId="painel-saidas"
        />
        <Numero rotulo="Cliques no botão" valor={r.cliques} testId="painel-cliques" />
        <Numero rotulo="Falhas" valor={r.falhas} alerta={r.falhas > 0} testId="painel-falhas" />
      </div>

      {semEntrega && (
        <p className="text-xs text-muted-foreground">
          Nenhum aviso de entrega chegou ainda. Campanhas enviadas antes da atualização que passou a registrar
          entregues e lidas mostram só o que a Meta aceitou.
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        Respostas e pedidos para sair contam até 72 horas depois do envio. Lidas dependem da confirmação de
        leitura do cliente, que pode estar desligada.
      </p>

      {r.falhas_por_codigo.length > 0 && (
        <div className="flex flex-col gap-1" data-testid="painel-falhas-por-codigo">
          <span className="text-sm font-medium">Falhas por motivo</span>
          <ul className="flex flex-col gap-1">
            {r.falhas_por_codigo.map((f) => (
              <li key={f.codigo} className="flex gap-3 rounded-md bg-muted/50 px-3 py-2 text-sm">
                <span className="w-14 shrink-0 font-semibold tabular-nums">{f.quantidade.toLocaleString("pt-BR")}</span>
                <span className="flex flex-col">
                  <span>{f.explicacao}</span>
                  {/^\d+$/.test(f.codigo) && <span className="text-xs text-muted-foreground">Código {f.codigo} da Meta</span>}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
