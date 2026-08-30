"use client";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import type { Customer } from "@/app/api/v1/customers/route";

interface ListResponse {
  data: Customer[];
}

export function useCustomerList(search: string) {
  return useQuery({
    queryKey: ["customers", search],
    queryFn: async () => {
      const qs = new URLSearchParams();
      if (search) qs.set("search", search);
      return apiClient.get<ListResponse>(`/api/v1/customers?${qs.toString()}`);
    },
  });
}
