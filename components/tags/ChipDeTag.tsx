import { cn } from "@/lib/utils";
import { rotuloDoValor, tomDoValor, type GrupoChave, type Tom } from "@/lib/tags/estruturadas";

/** Tom → tokens do tema. Quente/morno/frio reaproveitam erro/atenção/informação. */
export const CLASSE_DO_CHIP: Readonly<Record<Tom, string>> = {
  quente: "bg-error-bg text-error-fg",
  morno: "bg-warning-bg text-warning-fg",
  frio: "bg-info-bg text-info-fg",
  neutro: "bg-muted text-muted-foreground",
};

/** A bolinha do card (6px) — mesma cor do chip, sem ocupar altura. */
export const CLASSE_DO_PONTO: Readonly<Record<Tom, string>> = {
  quente: "bg-error",
  morno: "bg-warning",
  frio: "bg-info",
  neutro: "bg-muted-foreground",
};

interface Props {
  grupo: GrupoChave;
  valor: string;
  className?: string;
}

export function ChipDeTag({ grupo, valor, className }: Props) {
  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center rounded-full px-2 py-0.5 text-[11px] font-medium leading-4",
        CLASSE_DO_CHIP[tomDoValor(grupo, valor)],
        className,
      )}
      title={valor}
    >
      <span className="truncate">{rotuloDoValor(grupo, valor)}</span>
    </span>
  );
}
