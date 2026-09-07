"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { apiClient } from "@/lib/api/client";

export interface TemplateSlotView {
  key: string;
  expects: string;
  /** Rótulo humano do endereço: "corpo", "cabeçalho", "card 2 › cabeçalho". */
  onde: string;
}

/** Texto de um componente, inteiro e uma vez só — a UI marca os `{{n}}`. */
export interface TemplatePreview {
  onde: string;
  text: string;
}

export interface TemplateView {
  name: string;
  language: string;
  status: string;
  category: string | null;
  rejectedReason: string | null;
  qualityScore: string | null;
  parameterFormat: string;
  contractHash: string;
  syncedAt: string;
  /** DERIVADOS do template pela API — nunca digitados, nunca contados à mão. */
  slots: TemplateSlotView[];
  previews: TemplatePreview[];
  /** A definição crua — a tela de campanhas deriva o próprio contrato dela. */
  components: unknown[];
}

export interface TemplatesPayload {
  /** `null` = canal oficial não conectado. Distinto de "conectado e sem template". */
  waba: string | null;
  /** Id da sessão (`channel_sessions.id`) — o que a tela de campanhas grava. */
  channelSessionId: string | null;
  templates: TemplateView[];
}

export interface SyncCounts {
  inserted: number;
  updated: number;
  unchanged: number;
  disabled: number;
}

export function useTemplates() {
  return useQuery({
    queryKey: ["channel-templates"],
    queryFn: async () => apiClient.get<{ data: TemplatesPayload }>("/api/v1/channels/templates"),
    staleTime: 30_000,
  });
}

export function useSyncTemplates() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => apiClient.post<{ data: SyncCounts }>("/api/v1/channels/templates", {}),
    onError: showApiError,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["channel-templates"] });
    },
  });
}

export interface CreateTemplateInput {
  name: string;
  language: string;
  category: string;
  components: unknown[];
}

/**
 * Cria a definição direto na WABA e já sincroniza — a mesma rota faz as duas
 * coisas, porque separar obrigaria a tela a saber que criar também sincroniza.
 */
export function useCreateTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateTemplateInput) =>
      apiClient.post<{ data: SyncCounts }>("/api/v1/channels/templates", {
        acao: "criar",
        ...input,
      }),
    onError: showApiError,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["channel-templates"] });
    },
  });
}
