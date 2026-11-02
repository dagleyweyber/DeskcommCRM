"use client";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import type { TagDosContatos } from "@/lib/types/contacts";

/** Todas as tags dos contatos da organização, com contagem (GET /api/v1/contacts/tags). */
export function useContactTags() {
  return useQuery({
    queryKey: ["contacts", "tags"],
    queryFn: async () => (await apiClient.get<{ data: TagDosContatos[] }>("/api/v1/contacts/tags")).data,
    staleTime: 30_000,
  });
}
