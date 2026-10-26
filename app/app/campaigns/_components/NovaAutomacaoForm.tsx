"use client";
import { useMemo, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { TemplateEVariaveisPicker } from "@/components/campaigns/TemplateEVariaveisPicker";
import { useCreateAutomation, type CreateAutomationInput } from "@/hooks/campaigns/useAutomations";
import { useEventTypes } from "@/hooks/agenda/useEventTypes";
import { useTemplates } from "@/hooks/channels/useTemplates";
import {
  fraseDosValoresSemFonte,
  valoresSemFonte,
  type Definicao,
} from "@/lib/channels/valores-sem-fonte";
import type { VariableMapping } from "@/lib/messaging/variable-mapping";

/**
 * Só "Confirmação de agendamento" existe hoje — o seletor de gatilho já
 * está aqui pronto pra crescer (a próxima entrega anunciada é
 * aniversariantes), mas o valor É fixo até um segundo `trigger_kind`
 * ganhar resolver em `lib/automations/triggers/`.
 */
const GATILHOS: Array<{ value: CreateAutomationInput["trigger_kind"]; label: string; descricao: string }> = [
  {
    value: "appointment_reminder",
    label: "Confirmação de agendamento",
    descricao:
      "Todo lead com um agendamento marcado pra hoje recebe o modelo às 8h — sem precisar disparar na mão.",
  },
];

export function NovaAutomacaoForm({ onCriada }: { onCriada: () => void }) {
  const templates = useTemplates();
  const criar = useCreateAutomation();
  const servicos = useEventTypes();

  const [nome, setNome] = useState("");
  const [templateEscolhido, setTemplateEscolhido] = useState("");
  const [mapping, setMapping] = useState<VariableMapping>({});
  // "" = todos os serviços (o comportamento de sempre).
  const [servicoId, setServicoId] = useState("");

  const aprovados = useMemo(
    () => (templates.data?.data.templates ?? []).filter((t) => t.status === "APPROVED"),
    [templates.data],
  );
  const atual = aprovados.find((t) => `${t.name}|${t.language}` === templateEscolhido) ?? null;

  // Toda variável do modelo precisa de uma origem ANTES de criar (a API confere de novo).
  const semFonte = useMemo(
    () =>
      atual
        ? valoresSemFonte(
            {
              name: atual.name,
              language: atual.language,
              parameter_format: atual.parameterFormat,
              components: atual.components as Definicao["components"],
            },
            mapping,
          )
        : [],
    [atual, mapping],
  );

  function criarAutomacao() {
    const channelSessionId = templates.data?.data.channelSessionId;
    if (!nome.trim() || !atual || !channelSessionId) return;
    criar.mutate(
      {
        name: nome.trim(),
        trigger_kind: "appointment_reminder",
        channel_session_id: channelSessionId,
        template_name: atual.name,
        template_language: atual.language,
        variable_mapping: mapping,
        event_type_id: servicoId || null,
      },
      {
        onSuccess: () => {
          toast.success("Automação criada. Revise e clique em Ativar quando estiver pronta.");
          onCriada();
        },
      },
    );
  }

  return (
    <div className="flex flex-col gap-4 rounded-md border border-border p-4">
      <div className="flex flex-col gap-1">
        <label className="text-sm font-medium" htmlFor="automacao-nome">
          Nome da automação
        </label>
        <input
          id="automacao-nome"
          value={nome}
          onChange={(e) => setNome(e.target.value)}
          placeholder="Ex.: Lembrete de consulta"
          className="h-9 rounded-md border border-input bg-background px-2 text-sm"
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">Gatilho</span>
        {GATILHOS.map((g) => (
          <label key={g.value} className="flex items-start gap-2 rounded-md border border-input p-2 text-sm">
            <input type="radio" name="trigger-kind" checked readOnly className="mt-1" />
            <span>
              <span className="font-medium">{g.label}</span>
              <p className="text-xs text-muted-foreground">{g.descricao}</p>
            </span>
          </label>
        ))}
      </div>

      <div className="flex flex-col gap-1">
        <label className="text-sm font-medium" htmlFor="automacao-servico">
          Serviço
        </label>
        <select
          id="automacao-servico"
          value={servicoId}
          onChange={(e) => setServicoId(e.target.value)}
          className="h-9 rounded-md border border-input bg-background px-2 text-sm"
        >
          <option value="">Todos os serviços</option>
          {(servicos.data ?? [])
            .filter((t) => t.is_active)
            .map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
        </select>
        <p className="text-xs text-muted-foreground">
          {servicoId
            ? "Esta automação só envia para agendamentos deste serviço. Crie uma automação para cada serviço, cada uma com o seu modelo."
            : "Envia para agendamentos de qualquer serviço — menos os que tiverem uma automação própria ativa (a específica vence). Para mandar um modelo diferente por serviço, escolha o serviço aqui."}
        </p>
      </div>

      <TemplateEVariaveisPicker
        aprovados={aprovados}
        templateEscolhido={templateEscolhido}
        onTemplateChange={setTemplateEscolhido}
        mapping={mapping}
        onMappingChange={setMapping}
        fontesExtras={[
          { kind: "appointment_date", label: "Data do agendamento" },
          { kind: "appointment_time", label: "Hora do agendamento" },
        ]}
      />

      {semFonte.length > 0 && (
        <p className="text-sm text-amber-700 dark:text-amber-500" data-testid="automacao-variaveis-faltando">
          {fraseDosValoresSemFonte(semFonte)}
        </p>
      )}

      <div className="flex justify-end">
        <Button
          type="button"
          onClick={criarAutomacao}
          disabled={
            !nome.trim() ||
            !atual ||
            semFonte.length > 0 ||
            criar.isPending ||
            !templates.data?.data.channelSessionId
          }
        >
          {criar.isPending ? "Criando…" : "Criar automação"}
        </Button>
      </div>
    </div>
  );
}
