"use client";
import { useQuery } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";
import type { Saude, SaudeDaClinica } from "@/lib/admin/saude-das-clinicas";

export interface ResumoDeSaude {
  total: number;
  critico: number;
  atencao: number;
  ok: number;
  suspenso: number;
}

export interface SaudeDasClinicasResposta {
  resumo: ResumoDeSaude;
  clinicas: SaudeDaClinica[];
  apurado_em: string;
}

export type { Saude, SaudeDaClinica };

/**
 * SEM `refetchInterval` de propósito.
 *
 * Painel que se atualiza sozinho a cada poucos segundos vira consulta
 * permanente ao banco pelo tempo que a aba ficar aberta — e aba de admin fica
 * aberta o dia inteiro. Depois do incidente de Disk IO em 100%, custo
 * contínuo e invisível é exatamente o que não se cria. `staleTime` de 1
 * minuto segura reaberturas da tela; atualizar é um clique explícito.
 */
export function useSaudeDasClinicas() {
  return useQuery({
    queryKey: ["admin", "saude-das-clinicas"],
    queryFn: () =>
      apiClient.get<{ data: SaudeDasClinicasResposta }>("/api/v1/admin/saude-das-clinicas"),
    select: (r) => r.data,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
}
