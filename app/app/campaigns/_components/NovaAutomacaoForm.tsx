"use client";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { TemplateEVariaveisPicker } from "@/components/campaigns/TemplateEVariaveisPicker";
import { useCreateAutomation, type CreateAutomationInput, type TimingKind } from "@/hooks/campaigns/useAutomations";
import { useEventTypes } from "@/hooks/agenda/useEventTypes";
import { useTemplates } from "@/hooks/channels/useTemplates";
import {
  fraseDosValoresSemFonte,
  valoresSemFonte,
  type Definicao,
} from "@/lib/channels/valores-sem-fonte";
import type { VariableMapping } from "@/lib/messaging/variable-mapping";
import { botoesDeRespostaRapida } from "@/lib/agenda/confirmacao";

/**
 * Quando enviar em relação ao compromisso (migration 0201). Lista fechada de
 * opções em vez de campo livre: é o que a recepção entende e o que o CHECK do
 * banco aceita (1–7 dias, 1–72 horas).
 */
const MOMENTOS: Array<{ chave: string; kind: TimingKind; value: number | null; label: string }> = [
  { chave: "day_of_8am", kind: "day_of_8am", value: null, label: "No dia do agendamento, às 8h" },
  { chave: "days_before:1", kind: "days_before", value: 1, label: "1 dia antes, às 8h" },
  { chave: "days_before:2", kind: "days_before", value: 2, label: "2 dias antes, às 8h" },
  { chave: "days_before:3", kind: "days_before", value: 3, label: "3 dias antes, às 8h" },
  { chave: "days_before:7", kind: "days_before", value: 7, label: "1 semana antes, às 8h" },
  { chave: "hours_before:1", kind: "hours_before", value: 1, label: "1 hora antes" },
  { chave: "hours_before:2", kind: "hours_before", value: 2, label: "2 horas antes" },
  { chave: "hours_before:3", kind: "hours_before", value: 3, label: "3 horas antes" },
  { chave: "hours_before:6", kind: "hours_before", value: 6, label: "6 horas antes" },
  { chave: "hours_before:24", kind: "hours_before", value: 24, label: "24 horas antes" },
];

/** Texto curto do momento de envio — usado também na lista de automações. */
export function rotuloDoMomento(kind: TimingKind, value: number | null): string {
  const conhecido = MOMENTOS.find((m) => m.kind === kind && m.value === value);
  if (conhecido) return conhecido.label;
  if (kind === "days_before") return `${value} dia(s) antes, às 8h`;
  if (kind === "hours_before") return `${value} hora(s) antes`;
  return "No dia do agendamento, às 8h";
}

/** Palpite inicial de qual botão confirma/desmarca — a pessoa confere e troca se precisar. */
function palpite(botoes: string[], padrao: RegExp): string {
  return botoes.find((b) => padrao.test(b.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase())) ?? "";
}

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
      "Todo compromisso da Agenda recebe o modelo no momento escolhido abaixo — sem precisar disparar na mão.",
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
  const [momento, setMomento] = useState("day_of_8am");
  const [botaoConfirma, setBotaoConfirma] = useState("");
  const [botaoDesmarca, setBotaoDesmarca] = useState("");

  const aprovados = useMemo(
    () => (templates.data?.data.templates ?? []).filter((t) => t.status === "APPROVED"),
    [templates.data],
  );
  const atual = aprovados.find((t) => `${t.name}|${t.language}` === templateEscolhido) ?? null;
  const botoes = useMemo(() => (atual ? botoesDeRespostaRapida(atual.components) : []), [atual]);

  // Trocou de modelo: sugere os botões pelo texto (a pessoa confere).
  useEffect(() => {
    setBotaoConfirma(palpite(botoes, /confirm|sim|vou/));
    setBotaoDesmarca(palpite(botoes, /remarc|cancel|nao|desmarc/));
  }, [botoes]);

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

  const momentoEscolhido = MOMENTOS.find((m) => m.chave === momento) ?? MOMENTOS[0]!;

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
        timing_kind: momentoEscolhido.kind,
        timing_value: momentoEscolhido.value,
        confirm_button_text: botaoConfirma || null,
        decline_button_text: botaoDesmarca || null,
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

      <div className="flex flex-col gap-1">
        <label className="text-sm font-medium" htmlFor="automacao-momento">
          Quando enviar
        </label>
        <select
          id="automacao-momento"
          value={momento}
          onChange={(e) => setMomento(e.target.value)}
          className="h-9 rounded-md border border-input bg-background px-2 text-sm"
        >
          {MOMENTOS.map((m) => (
            <option key={m.chave} value={m.chave}>
              {m.label}
            </option>
          ))}
        </select>
        <p className="text-xs text-muted-foreground">
          Compromisso marcado depois desse momento recebe a mensagem logo em seguida (dentro do horário de envio, 7h–22h).
          Para confirmar 1 dia antes E lembrar no dia, crie duas automações.
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

      {atual && botoes.length > 0 && (
        <div className="flex flex-col gap-2 rounded-md border border-input p-3" data-testid="automacao-botoes">
          <span className="text-sm font-medium">Confirmação pela resposta do cliente</span>
          <p className="text-xs text-muted-foreground">
            Quando o cliente tocar num botão do modelo, o compromisso muda de status na Agenda sozinho. A resposta
            &quot;não vou&quot; deixa o horário reservado e avisa a equipe na Central para remarcar.
          </p>
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-sm">
              Botão que CONFIRMA
              <select
                value={botaoConfirma}
                onChange={(e) => setBotaoConfirma(e.target.value)}
                className="h-9 rounded-md border border-input bg-background px-2 text-sm"
              >
                <option value="">Nenhum</option>
                {botoes.map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-sm">
              Botão que DESMARCA
              <select
                value={botaoDesmarca}
                onChange={(e) => setBotaoDesmarca(e.target.value)}
                className="h-9 rounded-md border border-input bg-background px-2 text-sm"
              >
                <option value="">Nenhum</option>
                {botoes.map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {botaoConfirma && botaoConfirma === botaoDesmarca && (
            <p className="text-xs text-destructive">O mesmo botão não pode confirmar e desmarcar.</p>
          )}
        </div>
      )}

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
            (Boolean(botaoConfirma) && botaoConfirma === botaoDesmarca) ||
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
