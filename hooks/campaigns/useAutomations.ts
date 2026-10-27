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
