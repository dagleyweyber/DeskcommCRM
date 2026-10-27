import type { StatusDoCompromisso } from "@/lib/agenda/tipos";

/**
 * Cor de cada status na grade e nos selos. Verde fica SÓ para "Confirmado":
 * até a 0200 o app gravava `confirmed` ao criar e por isso a grade não usava
 * verde (ver histórico de GradeDoDia). Agora `confirmed` significa que o
 * cliente confirmou, e o verde passa a dizer exatamente isso.
 */
export const CLASSE_DO_CARD: Record<StatusDoCompromisso, string> = {
  pending: "border-sky-500/70 bg-sky-500/15",
  confirmed: "border-emerald-600/70 bg-emerald-500/20",
  declined: "border-red-500/80 bg-red-500/15",
  completed: "border-slate-400/60 bg-slate-400/15",
  no_show: "border-orange-500/70 bg-orange-500/15",
  cancelled: "border-border bg-muted/40 opacity-60",
};

export const CLASSE_DO_SELO: Record<StatusDoCompromisso, string> = {
  pending: "bg-sky-600 text-white",
  confirmed: "bg-emerald-600 text-white",
  declined: "bg-red-600 text-white",
  completed: "bg-slate-600 text-white",
  no_show: "bg-orange-600 text-white",
  cancelled: "bg-muted text-muted-foreground",
};
