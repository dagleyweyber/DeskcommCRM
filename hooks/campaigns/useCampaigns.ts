"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { apiClient } from "@/lib/api/client";
import type { AudienceFilter } from "@/lib/campaigns/audience";
import type { VariableMapping } from "@/lib/campaigns/resolve-values";

export interface CampaignSummary {
  id: string;
  name: string;
  status: "draft" | "queued" | "running" | "paused" | "completed" | "cancelled";
  template_name: string;
  template_language: string;
  total_recipients: number;
  sent_count: number;
  failed_count: number;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

const QUERY_KEY = ["campaigns"];

export function useCampaigns() {
  return useQuery({
    queryKey: QUERY_KEY,
    queryFn: async () => apiClient.get<{ data: { campaigns: CampaignSummary[] } }>("/api/v1/campaigns"),
    // Campanha em andamento muda a cada minuto (o despachante roda a cada
    // tick de cron) — sem refetch periódico a barra de progresso ficaria
    // parada até o operador recarregar a página à mão.
    refetchInterval: (query) =>
      (query.state.data?.data.campaigns ?? []).some((c) => c.status === "running" || c.status === "queued")
        ? 15_000
        : false,
  });
}

export interface CreateCampaignInput {
  name: string;
  channel_session_id: string;
  template_name: string;
  template_language: string;
  variable_mapping: VariableMapping;
  audience: AudienceFilter;
}

export function useCreateCampaign() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateCampaignInput) =>
      apiClient.post<{ data: { id: string; total_recipients: number } }>("/api/v1/campaigns", input),
    onError: showApiError,
    onSuccess: () => qc.invalidateQueries({ queryKey: QUERY_KEY }),
  });
}

export function usePreviewAudience() {
  return useMutation({
    mutationFn: async (audience: AudienceFilter) =>
      apiClient.post<{ data: { total: number } }>("/api/v1/campaigns/preview", audience),
    onError: showApiError,
  });
}

function useCampaignAction(acao: "start" | "pause" | "cancel") {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) =>
      apiClient.post<{ data: { status: string } }>(`/api/v1/campaigns/${id}/${acao}`, {}),
    onError: showApiError,
    onSuccess: () => qc.invalidateQueries({ queryKey: QUERY_KEY }),
  });
}

export const useStartCampaign = () => useCampaignAction("start");
export const usePauseCampaign = () => useCampaignAction("pause");
export const useCancelCampaign = () => useCampaignAction("cancel");
