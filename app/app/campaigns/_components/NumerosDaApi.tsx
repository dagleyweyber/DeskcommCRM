"use client";
/**
 * A saúde de cada número da API oficial, no topo da aba Disparos: a nota de qualidade que a
 * Meta dá ao número e quantos contatos diferentes ele pode alcançar em 24 horas.
 *
 * É o primeiro lugar a olhar antes de criar uma campanha grande — número em vermelho ou com
 * limite baixo não aguenta 2.000 contatos.
 */
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { useNumerosDaApi, type NumeroDaApi } from "@/hooks/campaigns/useCampaigns";

const QUALIDADE: Record<string, { rotulo: string; classe: string; texto: string }> = {
  GREEN: {
    rotulo: "Alta",
    classe: "bg-emerald-600 text-white hover:bg-emerald-600",
    texto: "Boa: pode disparar normalmente.",
  },
  YELLOW: {
    rotulo: "Média",
    classe: "bg-amber-500 text-white hover:bg-amber-500",
    texto: "Atenção: muita gente bloqueando ou denunciando. Diminua o volume e revise as mensagens.",
  },
  RED: {
    rotulo: "Baixa",
    classe: "bg-red-600 text-white hover:bg-red-600",
    texto: "Risco: a Meta pode reduzir o limite do número. Evite campanhas até a qualidade melhorar.",
  },
};

/** TIER_1K → "até 1.000 contatos por dia". */
export function textoDoLimite(limite: string | null): string | null {
  if (!limite) return null;
  if (limite.toUpperCase() === "TIER_UNLIMITED") return "sem limite diário de contatos";
  const m = /^TIER_(\d+)(K)?$/i.exec(limite);
  if (!m) return limite;
  const n = Number(m[1]) * (m[2] ? 1000 : 1);
  return `até ${n.toLocaleString("pt-BR")} contatos diferentes a cada 24 h`;
}

function LinhaDoNumero({ n }: { n: NumeroDaApi }) {
  const q = n.qualidade ? QUALIDADE[n.qualidade.toUpperCase()] : undefined;
  const limite = textoDoLimite(n.limite);
  return (
    <li className="flex flex-col gap-1 rounded-md border border-border p-3" data-testid="numero-da-api">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{n.nome}</span>
        {q ? (
          <Badge className={q.classe}>Qualidade {q.rotulo}</Badge>
        ) : (
          <Badge variant="outline">Qualidade ainda não informada</Badge>
        )}
        {!n.conectado && <Badge variant="destructive">Desconectado</Badge>}
        {n.campanhas_andando > 0 && (
          <span className="text-xs text-muted-foreground">{n.campanhas_andando} campanha(s) enviando</span>
        )}
      </div>
      <span className="text-xs text-muted-foreground">
        {[q?.texto, limite ? `Limite: ${limite}.` : null].filter(Boolean).join(" ")}
      </span>
    </li>
  );
}

export function NumerosDaApi() {
  const { data, isPending } = useNumerosDaApi();
  const numeros = data?.data.numeros ?? [];
  if (isPending || numeros.length === 0) return null;

  return (
    <Card className="p-4" data-testid="numeros-da-api">
      <h2 className="text-sm font-medium">Saúde dos números (API oficial)</h2>
      <p className="mt-1 text-xs text-muted-foreground">
        A Meta dá uma nota a cada número conforme bloqueios e denúncias. Atualiza a cada 5 minutos.
      </p>
      <ul className="mt-3 grid gap-2 md:grid-cols-2">
        {numeros.map((n) => (
          <LinhaDoNumero key={n.id} n={n} />
        ))}
      </ul>
    </Card>
  );
}
