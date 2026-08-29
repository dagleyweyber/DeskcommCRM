import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface KpiCardProps {
  title: string;
  value: string;
  /** Ex.: "Todo período" — quando o número NÃO respeita o filtro de data do dashboard. */
  subtitle?: string;
}

export function KpiCard({ title, value, subtitle }: KpiCardProps) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="truncate text-sm font-medium text-muted-foreground" title={title}>
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {/* `truncate` é rede de segurança, não a correção principal — o valor
            não deve estourar em condições normais de largura (o card tem
            espaço de sobra); se estourar mesmo assim (fonte grande do
            usuário, tela muito estreita), reticências em vez de cortar o
            dígito no meio. */}
        <p className="truncate text-2xl font-semibold tabular-nums" title={value}>
          {value}
        </p>
        {subtitle && <p className="mt-0.5 text-xs text-muted-foreground">{subtitle}</p>}
      </CardContent>
    </Card>
  );
}
