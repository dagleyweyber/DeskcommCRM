"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import type { Contact } from "@/lib/types/contacts";
import type { ContactCreate } from "@/lib/schemas/contacts";

/**
 * O handler devolve `{ contact, action }` dentro de `data` — não `data` como o
 * Contact direto. Achado ao vivo: os dois chamadores que liam `res.data.id`
 * (`NewLeadDialog`/`LeadFieldsForm`) pegavam sempre `undefined`, e o lead
 * nascia sem `contact_id` mesmo quando o contato foi criado com sucesso, sem
 * nenhum erro pra avisar. Este tipo é o contrato real — os e2e que já leem
 * `data.contact.id` (`contato-salva-email.spec.ts` etc.) confirmam.
 */
export interface CreateContactResponse {
  data: { contact: Contact; action: "created" };
}

export function useCreateContact() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: ContactCreate) =>
      apiClient.post<CreateContactResponse>("/api/v1/contacts", input),
    onError: showApiError,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["contacts"] });
    },
  });
}
