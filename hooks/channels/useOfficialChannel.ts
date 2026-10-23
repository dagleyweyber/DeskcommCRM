"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { apiClient } from "@/lib/api/client";

export interface OfficialChannelState {
  connected: boolean;
  /** Existe token gravado? O token em si NUNCA volta — ver a rota. */
  hasToken: boolean;
  phoneNumberId: string | null;
  wabaId: string | null;
  appId: string | null;
  connectionMode: "byo" | "embedded_coexistence" | null;
  displayName: string | null;
  phoneNumber: string | null;
  status: string | null;
  webhook: {
    callbackUrl: string;
    verifyToken: string | null;
    fields: string[];
  } | null;
}

export interface ConnectInput {
  phone_number_id: string;
  waba_id: string;
  token: string;
  app_id?: string;
}

export function useOfficialChannel() {
  return useQuery({
    queryKey: ["official-channel"],
    queryFn: async () => apiClient.get<{ data: OfficialChannelState }>("/api/v1/channels/official"),
    staleTime: 15_000,
  });
}

export function useConnectOfficialChannel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: ConnectInput) =>
      apiClient.post<{ data: { connected: boolean; displayName: string; phoneNumber: string | null } }>(
        "/api/v1/channels/official",
        input,
      ),
    onError: showApiError,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["official-channel"] });
    },
  });
}

export type EmbeddedConfig = { enabled: false } | { enabled: true; appId: string; configId: string };

/** O modo "Conectar com a Meta" existe nesta instalação? Config vem em runtime (ver a rota). */
export function useEmbeddedSignupConfig() {
  return useQuery({
    queryKey: ["official-channel-embedded"],
    queryFn: async () =>
      apiClient.get<{ data: EmbeddedConfig }>("/api/v1/channels/official/embedded"),
    staleTime: 60_000,
  });
}

export interface ConcluirEmbeddedInput {
  code: string;
  waba_id: string;
  phone_number_id?: string;
}

export function useConcluirEmbeddedSignup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: ConcluirEmbeddedInput) =>
      apiClient.post<{ data: { connected: boolean; displayName: string; phoneNumber: string | null } }>(
        "/api/v1/channels/official/embedded",
        input,
      ),
    onError: showApiError,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["official-channel"] });
    },
  });
}
