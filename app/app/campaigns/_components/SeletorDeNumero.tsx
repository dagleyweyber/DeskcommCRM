"use client";
/**
 * "Por qual número vai sair?" — o primeiro passo de campanha e de automação.
 *
 *   - sem número oficial conectado: não renderiza (o formulário já explica o que falta);
 *   - UM número: mostra qual é, sem perguntar;
 *   - DOIS ou mais: pergunta, mostrando a saúde de cada um (nota da Meta e limite diário) e avisa
 *     antes de criar se o escolhido está desconectado ou com qualidade baixa.
 *
 * O número escolhido é do pai (`valor`): trocar de número muda a lista de modelos, e quem
 * conhece o que precisa zerar (modelo, variáveis) é o formulário, não este componente.
 */
import { useEffect } from "react";

import { useNumerosDaApi } from "@/hooks/campaigns/useCampaigns";
import { avisoDoNumero, numeroInicial, rotuloDoNumero } from "@/lib/campaigns/numero-de-envio";

const COR_DO_AVISO = {
  bloqueio: "border-red-300 bg-red-50 text-red-900 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200",
  risco: "border-red-300 bg-red-50 text-red-900 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200",
  atencao: "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200",
} as const;

/** O número escolhido (ou `null`), mais o que o formulário precisa para decidir se pode criar. */
export function useNumeroEscolhido(valor: string | null, onChange: (id: string | null) => void) {
  const { data, isPending } = useNumerosDaApi();
  const numeros = data?.data.numeros ?? [];
  const unico = numeroInicial(numeros);

  // Um número só: já é o escolhido. Com vários, o valor fica como o operador deixou.
  useEffect(() => {
    if (valor === null && unico !== null) onChange(unico);
  }, [valor, unico, onChange]);

  const escolhido = numeros.find((n) => n.id === valor) ?? null;
  const aviso = avisoDoNumero(escolhido);
  return { numeros, escolhido, aviso, carregando: isPending, bloqueado: aviso?.nivel === "bloqueio" };
}

export function SeletorDeNumero({
  estado,
  valor,
  onChange,
}: {
  /** O que `useNumeroEscolhido` devolveu — o formulário chama o hook UMA vez e reparte. */
  estado: ReturnType<typeof useNumeroEscolhido>;
  valor: string | null;
  onChange: (id: string | null) => void;
}) {
  const { numeros, escolhido, aviso } = estado;
  if (numeros.length === 0) return null;

  return (
    <div className="flex flex-col gap-1" data-testid="seletor-de-numero">
      <label className="text-sm font-medium" htmlFor="seletor-de-numero-select">
        Número que vai enviar
      </label>
      {numeros.length === 1 ? (
        <p className="text-sm" data-testid="seletor-de-numero-unico">
          {rotuloDoNumero(numeros[0]!)}
        </p>
      ) : (
        <select
          id="seletor-de-numero-select"
          value={valor ?? ""}
          onChange={(e) => onChange(e.target.value || null)}
          className="h-9 rounded-md border border-input bg-background px-2 text-sm"
        >
          <option value="">Escolha o número…</option>
          {numeros.map((n) => (
            <option key={n.id} value={n.id}>
              {rotuloDoNumero(n)}
            </option>
          ))}
        </select>
      )}
      {numeros.length > 1 && valor === null && (
        <p className="text-xs text-muted-foreground">
          Esta organização tem {numeros.length} números oficiais. Os modelos e a qualidade mostrados são os do número escolhido.
        </p>
      )}
      {aviso && escolhido && (
        <p
          className={`rounded-md border px-3 py-2 text-xs ${COR_DO_AVISO[aviso.nivel]}`}
          data-testid="seletor-de-numero-aviso"
          data-nivel={aviso.nivel}
        >
          {aviso.texto}
        </p>
      )}
    </div>
  );
}
