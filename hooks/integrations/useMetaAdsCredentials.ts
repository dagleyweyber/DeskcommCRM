"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";

export interface MetaAdsCredentialsRow {
  id: string;
  organization_id: string;
  dataset_id: string;
  status: "connecting" | "healthy" | "invalid" | "error";
  last_error: string | null;
  created_at: string;
  updated_at: string;
  /** Token de leitura de campanha/conjunto/anúncio (Fase E) — independente do de Purchase. */
  ads_read_connected: boolean;
}

interface GetResponse {
  data: MetaAdsCredentialsRow | null;
}

export const metaAdsCredentialsQueryKey = ["integrations", "meta-ads", "credentials"] as const;

export function useMetaAdsCredentials(opts?: { initialData?: MetaAdsCredentialsRow | null }) {
  return useQuery({
    queryKey: metaAdsCredentialsQueryKey,
    queryFn: async () => {
      try {
        const res = await apiClient.get<GetResponse>("/api/v1/integrations/meta-ads/credentials");
        return res.data;
      } catch (err) {
        showApiError(err);
        throw err;
      }
    },
    initialData: opts?.initialData,
  });
}

interface ConnectArgs {
  access_token: string;
  dataset_id: string;
}

export function useConnectMetaAds() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: ConnectArgs) =>
      apiClient.post<{ data: MetaAdsCredentialsRow }>(
        "/api/v1/integrations/meta-ads/credentials",
        args,
      ),
    onError: showApiError,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: metaAdsCredentialsQueryKey });
    },
  });
}

export function useDisconnectMetaAds() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => apiClient.delete("/api/v1/integrations/meta-ads/credentials"),
    onError: showApiError,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: metaAdsCredentialsQueryKey });
    },
  });
}

export function useConnectMetaAdsReadToken() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: { ads_read_token: string }) =>
      apiClient.post("/api/v1/integrations/meta-ads/ads-read-token", args),
    onError: showApiError,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: metaAdsCredentialsQueryKey });
    },
  });
}

export function useDisconnectMetaAdsReadToken() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => apiClient.delete("/api/v1/integrations/meta-ads/ads-read-token"),
    onError: showApiError,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: metaAdsCredentialsQueryKey });
    },
  });
}
