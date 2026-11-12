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

/**
 * Os modelos do espelho. Com `channelSessionId`, só os DAQUELE número (organização com mais de
 * um número oficial); sem ele, o comportamento de sempre (primeiro número). `null` mantém a
 * consulta parada: a tela de campanha só pede depois de o operador escolher o número.
 */
export function useTemplates(channelSessionId?: string | null) {
  return useQuery({
    // A chave começa por "channel-templates": quem invalida o prefixo (sync, criar) atualiza todas.
    queryKey: ["channel-templates", channelSessionId ?? "padrao"],
    queryFn: async () =>
      apiClient.get<{ data: TemplatesPayload }>(
        channelSessionId
          ? `/api/v1/channels/templates?channel_session_id=${encodeURIComponent(channelSessionId)}`
          : "/api/v1/channels/templates",
      ),
    enabled: channelSessionId !== null,
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

/**
 * Apaga o modelo NA META (todos os idiomas do nome) e tira do espelho. A rota
 * devolve 409 com a lista de automações/campanhas que ainda usam o nome — a
 * mensagem do erro já diz quais, e o toast padrão a mostra.
 */
export function useDeleteTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (name: string) =>
      apiClient.delete<{ data: { name: string; languages: string[] } }>(
        `/api/v1/channels/templates?name=${encodeURIComponent(name)}`,
      ),
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

export interface EditTemplateInput {
  name: string;
  language: string;
  components: unknown[];
}

/**
 * Edita o CONTEÚDO de um modelo já existente na WABA e sincroniza. Nome, idioma e
 * categoria não mudam. A edição manda o modelo de volta para revisão da Meta.
 */
export function useEditTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: EditTemplateInput) =>
      apiClient.post<{ data: SyncCounts }>("/api/v1/channels/templates", {
        acao: "editar",
        ...input,
      }),
    onError: showApiError,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["channel-templates"] });
    },
  });
}

export interface UsoDoModeloView {
  tipo: "automacao" | "campanha";
  id: string;
  nome: string;
  status: string;
}

/** Automações e campanhas abertas que usam o modelo — mostrado antes de salvar a edição. */
export function useUsosDoModelo(name: string) {
  return useQuery({
    queryKey: ["channel-templates-usos", name],
    queryFn: async () =>
      apiClient.get<{ data: { usos: UsoDoModeloView[] } }>(
        `/api/v1/channels/templates/usos?name=${encodeURIComponent(name)}`,
      ),
    staleTime: 0,
  });
}
