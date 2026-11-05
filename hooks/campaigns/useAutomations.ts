"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { apiClient } from "@/lib/api/client";
import type { VariableMapping } from "@/lib/messaging/variable-mapping";

export interface AutomationSummary {
  id: string;
  name: string;
  trigger_kind: string;
  status: "draft" | "active" | "paused";
  template_name: string;
  template_language: string;
  /** O serviço da Agenda a que responde; `null` = todos os serviços. */
  event_type_id: string | null;
  event_type: { name: string } | null;
  timing_kind: TimingKind;
  timing_value: number | null;
  confirm_button_text: string | null;
  decline_button_text: string | null;
  created_at: string;
  updated_at: string;
}

/** Quando a automação envia em relação ao compromisso (migration 0201). */
export type TimingKind = "day_of_8am" | "days_before" | "hours_before";

const QUERY_KEY = ["automations"];

export function useAutomations() {
  return useQuery({
    queryKey: QUERY_KEY,
    queryFn: async () => apiClient.get<{ data: { automations: AutomationSummary[] } }>("/api/v1/automations"),
  });
}

export interface CreateAutomationInput {
  name: string;
  trigger_kind: "appointment_reminder";
  channel_session_id: string;
  template_name: string;
  template_language: string;
  variable_mapping: VariableMapping;
  /** `null`/ausente = todos os serviços. */
  event_type_id?: string | null;
  timing_kind?: TimingKind;
  timing_value?: number | null;
  /** Texto do botão do modelo que confirma presença — preenchido = automação de confirmação. */
  confirm_button_text?: string | null;
  decline_button_text?: string | null;
}

export function useCreateAutomation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateAutomationInput) =>
      apiClient.post<{ data: { id: string } }>("/api/v1/automations", input),
    onError: showApiError,
    onSuccess: () => qc.invalidateQueries({ queryKey: QUERY_KEY }),
  });
}

function useAutomationAction(acao: "activate" | "pause") {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) =>
      apiClient.post<{ data: { status: string } }>(`/api/v1/automations/${id}/${acao}`, {}),
    onError: showApiError,
    onSuccess: () => qc.invalidateQueries({ queryKey: QUERY_KEY }),
  });
}

export const useActivateAutomation = () => useAutomationAction("activate");
export const usePauseAutomation = () => useAutomationAction("pause");

/** O que o formulário de edição precisa: a configuração completa, inclusive o mapeamento das variáveis. */
export interface AutomationDetail {
  id: string;
  name: string;
  trigger_kind: string;
  channel_session_id: string;
  status: "draft" | "active" | "paused";
  template_name: string;
  template_language: string;
  variable_mapping: VariableMapping;
  event_type_id: string | null;
  timing_kind: TimingKind;
  timing_value: number | null;
  confirm_button_text: string | null;
  decline_button_text: string | null;
}

export function useAutomation(id: string) {
  return useQuery({
    queryKey: [...QUERY_KEY, id],
    queryFn: async () =>
      apiClient.get<{ data: { automation: AutomationDetail } }>(`/api/v1/automations/${id}`),
  });
}

/** Só o que mudou importa para a API, mas mandar o estado inteiro é seguro: ela compara e ignora o igual. */
export type UpdateAutomationInput = Partial<
  Pick<
    AutomationDetail,
    | "name"
    | "template_name"
    | "template_language"
    | "variable_mapping"
    | "event_type_id"
    | "timing_kind"
    | "timing_value"
    | "confirm_button_text"
    | "decline_button_text"
  >
>;

export function useUpdateAutomation(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: UpdateAutomationInput) =>
      apiClient.patch<{ data: { status: string; campos_alterados: string[] } }>(
        `/api/v1/automations/${id}`,
        input,
      ),
    onError: showApiError,
    // Lista E detalhe: o detalhe alimenta o formulário na próxima abertura.
    onSuccess: () => qc.invalidateQueries({ queryKey: QUERY_KEY }),
  });
}
