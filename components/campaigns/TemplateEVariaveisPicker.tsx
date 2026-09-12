"use client";
import { useMemo } from "react";

import { deriveTemplateContract, describeAddress } from "@/lib/channels/meta/template-contract";
import { slotKey } from "@/lib/channels/meta/build-components";
import type { VariableMapping, VariableSource } from "@/lib/messaging/variable-mapping";

/**
 * O seletor "modelo aprovado → mapear cada variável" — extraído de dentro
 * de `NovaCampanhaForm.tsx` porque `NovaAutomacaoForm.tsx` precisa do
 * MESMO pedaço, letra por letra (mesmo contrato de slots, mesmo desenho de
 * fixo/nome do contato). Componente CONTROLADO: quem usa é dono do
 * estado, este componente só apresenta e emite mudança — mesma razão de
 * `templateEscolhido` viver no formulário pai (o formulário precisa dele
 * pra montar o payload de criação, não só pra exibir).
 */
export interface TemplateAprovado {
  name: string;
  language: string;
  components: unknown;
}

const FONTES_BASE: Array<{ kind: VariableSource["kind"]; label: string }> = [
  { kind: "fixed", label: "Texto fixo" },
  { kind: "contact_name", label: "Nome do contato" },
  { kind: "contact_first_name", label: "Primeiro nome" },
];

interface Props {
  aprovados: TemplateAprovado[];
  templateEscolhido: string;
  onTemplateChange: (value: string) => void;
  mapping: VariableMapping;
  onMappingChange: (mapping: VariableMapping) => void;
  /** Fontes extras específicas de um gatilho (ex.: automação de agendamento oferece data/hora). */
  fontesExtras?: Array<{ kind: VariableSource["kind"]; label: string }>;
}

export function TemplateEVariaveisPicker({
  aprovados,
  templateEscolhido,
  onTemplateChange,
  mapping,
  onMappingChange,
  fontesExtras = [],
}: Props) {
  const atual = aprovados.find((t) => `${t.name}|${t.language}` === templateEscolhido) ?? null;
  const contrato = useMemo(
    () =>
      atual
        ? deriveTemplateContract({
            name: atual.name,
            language: atual.language,
            components: atual.components as never,
          })
        : null,
    [atual],
  );
  const fontes = [...FONTES_BASE, ...fontesExtras];

  return (
    <>
      <div className="flex flex-col gap-1">
        <label className="text-sm font-medium" htmlFor="template-picker">
          Modelo aprovado
        </label>
        {aprovados.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nenhum modelo aprovado ainda. Crie um em <strong>Conexões → Templates da Meta</strong>.
          </p>
        ) : (
          <select
            id="template-picker"
            value={templateEscolhido}
            onChange={(e) => {
              onTemplateChange(e.target.value);
              onMappingChange({});
            }}
            className="h-9 rounded-md border border-input bg-background px-2 text-sm"
          >
            <option value="">Escolha um modelo…</option>
            {aprovados.map((t) => (
              <option key={`${t.name}|${t.language}`} value={`${t.name}|${t.language}`}>
                {t.name} ({t.language})
              </option>
            ))}
          </select>
        )}
      </div>

      {contrato && contrato.slots.length > 0 && (
        <div className="flex flex-col gap-2 rounded-md bg-muted/40 p-3">
          <p className="text-xs text-muted-foreground">
            Este modelo pede {contrato.slots.length} valor(es). Escolha um texto fixo (igual pra
            todo mundo) ou um valor que muda por destinatário.
          </p>
          {contrato.slots.map((s) => {
            const key = slotKey(s.address, s.key);
            const fonte = mapping[key];
            return (
              <div key={key} className="flex flex-wrap items-center gap-2">
                <span className="w-40 shrink-0 text-xs text-muted-foreground">
                  {describeAddress(s.address)} · {s.contextBefore.slice(-15)}…
                </span>
                <select
                  value={fonte?.kind ?? "fixed"}
                  onChange={(e) => {
                    const kind = e.target.value as VariableSource["kind"];
                    const proximo: VariableSource =
                      kind === "fixed" ? { kind: "fixed", value: "" } : { kind };
                    onMappingChange({ ...mapping, [key]: proximo });
                  }}
                  aria-label={`Fonte do valor de ${describeAddress(s.address)}`}
                  className="h-8 w-44 rounded-md border border-input bg-background px-2 text-sm"
                >
                  {fontes.map((f) => (
                    <option key={f.kind} value={f.kind}>
                      {f.label}
                    </option>
                  ))}
                </select>
                {(!fonte || fonte.kind === "fixed") && (
                  <input
                    value={fonte?.kind === "fixed" ? fonte.value : ""}
                    onChange={(e) =>
                      onMappingChange({ ...mapping, [key]: { kind: "fixed", value: e.target.value } })
                    }
                    placeholder="Valor pra todo mundo"
                    aria-label={`Texto fixo de ${describeAddress(s.address)}`}
                    className="h-8 flex-1 rounded-md border border-input bg-background px-2 text-sm"
                  />
                )}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
