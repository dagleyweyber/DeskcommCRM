import { z } from "zod";

/**
 * Body para conectar um novo canal WhatsApp. `display_name` é opcional —
 * um rótulo amigável ("Vendas", "Suporte") que o WAHA sobrescreve com o
 * nome do perfil quando a sessão fica WORKING.
 */
export const createChannelSchema = z.object({
  display_name: z.string().trim().min(1).max(80).optional(),
});

export type CreateChannelInput = z.infer<typeof createChannelSchema>;

/**
 * Body do PATCH de um canal. Os dois campos são independentes e opcionais, mas
 * ao menos um é obrigatório.
 *
 * `display_name: null` (ou só espaços) limpa o apelido — a tela volta a mostrar o
 * número. `entry_pipeline_id: null` volta ao funil padrão da organização.
 */
export const updateChannelSchema = z
  .object({
    display_name: z
      .string()
      .trim()
      .max(80)
      .nullable()
      .transform((v) => (v === null || v === "" ? null : v))
      .optional(),
    entry_pipeline_id: z.string().uuid().nullable().optional(),
  })
  .strict()
  .refine((v) => v.display_name !== undefined || v.entry_pipeline_id !== undefined, {
    message: "Informe display_name ou entry_pipeline_id.",
  });

export type UpdateChannelInput = z.infer<typeof updateChannelSchema>;

/** Status canônicos de sessão (WAHA + DB CHECK constraint). */
export const CHANNEL_STATUSES = [
  "STARTING",
  "SCAN_QR_CODE",
  "WORKING",
  "STOPPED",
  "FAILED",
] as const;

export type ChannelStatus = (typeof CHANNEL_STATUSES)[number];

export function isChannelStatus(v: string): v is ChannelStatus {
  return (CHANNEL_STATUSES as readonly string[]).includes(v);
}
