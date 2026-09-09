"use client";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import type { Purchase } from "@/app/api/v1/contacts/[id]/purchases/route";

interface PurchasesResponse {
  data: { purchases: Purchase[] };
}

export function usePurchases(contactId: string) {
  return useQuery({
    queryKey: ["contact-purchases", contactId],
    enabled: !!contactId,
    queryFn: async () => apiClient.get<PurchasesResponse>(`/api/v1/contacts/${contactId}/purchases`),
  });
}
