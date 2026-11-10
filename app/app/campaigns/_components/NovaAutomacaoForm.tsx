"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { TemplateEVariaveisPicker } from "@/components/campaigns/TemplateEVariaveisPicker";
import { SeletorDeNumero, useNumeroEscolhido } from "./SeletorDeNumero";
import {
  useCreateAutomation,
  useUpdateAutomation,
  type AutomationDetail,
  type CreateAutomationInput,
  type TimingKind,
} from "@/hooks/campaigns/useAutomations";
import { useEventTypes } from "@/hooks/agenda/useEventTypes";
import { useTemplates } from "@/hooks/channels/useTemplates";
import {
  fraseDosValoresSemFonte,
  valoresSemFonte,
  type Definicao,
} from "@/lib/channels/valores-sem-fonte";
import type { VariableMapping } from "@/lib/messaging/variable-mapping";
import { botoesDeRespostaRapida } from "@/lib/agenda/botoes";

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

/** Chave do seletor de momento para um (kind, value) já gravado. */
function chaveDoMomento(kind: TimingKind, value: number | null): string {
  return kind === "day_of_8am" ? "day_of_8am" : `${kind}:${value}`;
}

interface FormProps {
  /** Presente = EDITAR esta automação; ausente = criar uma nova. */
  automacao?: AutomationDetail;
  /** Terminou (criou ou salvou) — o pai fecha o formulário. */
  onConcluido: () => void;
  /** Só na edição: desistir sem salvar. */
  onCancelar?: () => void;
}

export function AutomacaoForm({ automacao, onConcluido, onCancelar }: FormProps) {
  // Criar: o número é escolhido ANTES do modelo (cada número tem os seus). Editar: o número da
  // automação não muda — a lista continua a de sempre.
  const [numeroId, setNumeroId] = useState<string | null>(null);
  const templates = useTemplates(automacao ? undefined : numeroId);
  const criar = useCreateAutomation();
  const atualizar = useUpdateAutomation(automacao?.id ?? "");
  const servicos = useEventTypes();
  const editando = Boolean(automacao);

  const modeloInicial = automacao ? `${automacao.template_name}|${automacao.template_language}` : "";
  const momentoInicial = automacao ? chaveDoMomento(automacao.timing_kind, automacao.timing_value) : "day_of_8am";

  const [nome, setNome] = useState(automacao?.name ?? "");
  const [templateEscolhido, setTemplateEscolhido] = useState(modeloInicial);
  const [mapping, setMapping] = useState<VariableMapping>(automacao?.variable_mapping ?? {});
  // "" = todos os serviços (o comportamento de sempre).
  const [servicoId, setServicoId] = useState(automacao?.event_type_id ?? "");
  const [momento, setMomento] = useState(momentoInicial);
  const [botaoConfirma, setBotaoConfirma] = useState(automacao?.confirm_button_text ?? "");
  const [botaoDesmarca, setBotaoDesmarca] = useState(automacao?.decline_button_text ?? "");

  const trocarNumero = useCallback((id: string | null) => {
    setNumeroId(id);
    setTemplateEscolhido("");
    setMapping({});
  }, []);
  const numero = useNumeroEscolhido(editando ? null : numeroId, trocarNumero);

  const aprovados = useMemo(
    () => (templates.data?.data.templates ?? []).filter((t) => t.status === "APPROVED"),
    [templates.data],
  );
  const atual = aprovados.find((t) => `${t.name}|${t.language}` === templateEscolhido) ?? null;
  const botoes = useMemo(() => (atual ? botoesDeRespostaRapida(atual.components) : []), [atual]);

  // Trocou de modelo: sugere os botões pelo texto (a pessoa confere). Na EDIÇÃO, enquanto o
  // modelo for o que já estava salvo, os botões salvos valem — o palpite os apagaria.
  const primeiraLeitura = useRef(true);
  useEffect(() => {
    const ehPrimeira = primeiraLeitura.current;
    primeiraLeitura.current = false;
    if (editando && templateEscolhido === modeloInicial && (ehPrimeira || botoes.length > 0)) return;
    setBotaoConfirma(palpite(botoes, /confirm|sim|vou/));
    setBotaoDesmarca(palpite(botoes, /remarc|cancel|nao|desmarc/));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reage só à mudança dos botões do modelo
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

  function salvarAlteracoes() {
    if (!automacao || !nome.trim() || !atual) return;
    atualizar.mutate(
      {
        name: nome.trim(),
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
          toast.success(
            automacao.status === "active"
              ? "Automação atualizada. As mudanças valem para os próximos envios."
              : "Automação atualizada.",
          );
          onConcluido();
        },
      },
    );
  }

  function criarAutomacao() {
    const channelSessionId = numeroId;
    if (!nome.trim() || !atual || !channelSessionId || numero.bloqueado) return;
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
          onConcluido();
        },
      },
    );
  }

  return (
    <div className="flex flex-col gap-4 rounded-md border border-border p-4">
      {editando && automacao?.status === "active" && (
        <p
          className="rounded-md border border-amber-300/60 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-500/30 dark:bg-amber-950/20 dark:text-amber-100"
          data-testid="automacao-editando-ativa"
        >
          Esta automação está <strong>ativa</strong>. As mudanças valem para os próximos envios; quem já recebeu não
          recebe de novo.
          {momento !== momentoInicial &&
            " Mudar o momento de envio pode mandar a mensagem agora para compromissos que já passaram do novo momento."}
        </p>
      )}
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

      {!editando && <SeletorDeNumero estado={numero} valor={numeroId} onChange={trocarNumero} />}

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

      <div className="flex justify-end gap-2">
        {editando && onCancelar && (
          <Button type="button" variant="outline" onClick={onCancelar} disabled={atualizar.isPending}>
            Cancelar
          </Button>
        )}
        <Button
          type="button"
          onClick={editando ? salvarAlteracoes : criarAutomacao}
          disabled={
            !nome.trim() ||
            !atual ||
            semFonte.length > 0 ||
            (Boolean(botaoConfirma) && botaoConfirma === botaoDesmarca) ||
            criar.isPending ||
            atualizar.isPending ||
            (!editando && (!numeroId || numero.bloqueado))
          }
        >
          {editando
            ? atualizar.isPending
              ? "Salvando…"
              : "Salvar alterações"
            : criar.isPending
              ? "Criando…"
              : "Criar automação"}
        </Button>
      </div>
    </div>
  );
}

/** Criar uma automação nova — o nome de sempre, para quem não edita. */
export function NovaAutomacaoForm({ onCriada }: { onCriada: () => void }) {
  return <AutomacaoForm onConcluido={onCriada} />;
}
