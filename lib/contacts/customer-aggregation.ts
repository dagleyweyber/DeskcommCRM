/**
 * LTV + quantidade de compras por contato, a partir das linhas `won` de
 * `crm_leads` — pura, testável sem banco. Usada por `app/api/v1/customers/
 * route.ts`, extraída pela mesma razão de `lib/leads/next-meeting.ts`: a
 * lógica de agregação (não a query) precisa ser testável direto.
 */
export interface VendaGanha {
  contact_id: string | null;
  value_cents: number | null;
}

export interface ResumoDeCompras {
  ltv_cents: number;
  purchase_count: number;
}

export function agregarComprasPorContato(vendas: VendaGanha[]): Map<string, ResumoDeCompras> {
  const porContato = new Map<string, ResumoDeCompras>();
  for (const v of vendas) {
    if (!v.contact_id) continue;
    const atual = porContato.get(v.contact_id) ?? { ltv_cents: 0, purchase_count: 0 };
    atual.ltv_cents += v.value_cents ?? 0;
    atual.purchase_count += 1;
    porContato.set(v.contact_id, atual);
  }
  return porContato;
}
