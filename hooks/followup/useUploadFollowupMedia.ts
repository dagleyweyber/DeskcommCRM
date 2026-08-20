"use client";
import { useMutation } from "@tanstack/react-query";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { ApiError, type ApiErrorBody } from "@/lib/api/types";

export interface UploadedFollowupMedia {
  storage_path: string;
  media_mime: string;
  media_size_bytes: number;
  kind: "image" | "video" | "audio" | "document";
}

/** Mesmo formato do upload do composer (useUploadMedia) — escopo é a organização, não uma conversa. */
export function useUploadFollowupMedia() {
  return useMutation({
    mutationFn: async (args: { file: File; filename?: string }) => {
      const form = new FormData();
      form.append("file", args.file, args.filename ?? args.file.name);
      const res = await fetch("/api/v1/ai/followups/media", { method: "POST", body: form });
      const json = (await res.json()) as Partial<ApiErrorBody> & { data?: UploadedFollowupMedia };
      if (!res.ok || !json.data) {
        const e = json.error;
        throw new ApiError(res.status, e?.code ?? "upload_failed", e?.details, e?.request_id ?? "", e?.message);
      }
      return json.data;
    },
    onError: (err) => showApiError(err),
  });
}
