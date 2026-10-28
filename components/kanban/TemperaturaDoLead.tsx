"use client";
import { CLASSE_DO_CHIP } from "@/components/tags/ChipDeTag";
import { useEditLead } from "@/hooks/kanban/useUpdateLead";
import { cn } from "@/lib/utils";
import { GRUPO, comValor, grupoDe, semGrupo, valoresDoGrupo } from "@/lib/tags/estruturadas";
import type { Lead } from "@/lib/types/leads";

/**
 * Quente · Morno · Frio — a temperatura do lead, marcada à mão.
 *
 * Um clique marca; clicar de novo na que está marcada TIRA (lead sem temperatura é
 * um estado válido — a maioria nasce assim). É uma tag de grupo exclusivo, então
 * marcar outra troca a anterior: a regra mora em `comValor`, não aqui.
 *
 * Grava pelo mesmo `PATCH /leads/:id` do formulário, então o evento `lead.tag_added`
 * sai como sempre — uma automação "quando ficar quente, avise o vendedor" funciona
 * com `temperatura:quente`.
 */
export function TemperaturaDoLead({ lead, pipelineId }: { lead: Lead; pipelineId: string }) {
  const edit = useEditLead(pipelineId);
  const grupo = grupoDe(GRUPO.TEMPERATURA);
  if (!grupo?.valores) return null;
  const atual = valoresDoGrupo(lead.tags, GRUPO.TEMPERATURA)[0] ?? null;

  function marca(valor: string) {
    const tags = valor === atual ? semGrupo(lead.tags, GRUPO.TEMPERATURA) : comValor(lead.tags, GRUPO.TEMPERATURA, valor);
    edit.mutate({ leadId: lead.id, patch: { tags } });
  }

  return (
    <div role="group" aria-label="Temperatura do lead" className="flex items-center gap-1.5" data-testid="temperatura-do-lead">
      <span className="text-text-muted">Temperatura</span>
      {grupo.valores.map((v) => {
        const marcado = v.valor === atual;
        return (
          <button
            key={v.valor}
            type="button"
            aria-pressed={marcado}
            disabled={edit.isPending}
            onClick={() => marca(v.valor)}
            className={cn(
              "rounded-full border px-2 py-0.5 text-[11px] font-medium leading-4 transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60",
              marcado ? cn("border-transparent", CLASSE_DO_CHIP[v.tom]) : "border-border text-text-muted hover:border-border-strong hover:text-text",
            )}
          >
            {v.rotulo}
          </button>
        );
      })}
    </div>
  );
}
