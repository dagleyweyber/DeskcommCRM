/**
 * Origem de cada variável do modelo — compartilhada entre criar (POST /automations)
 * e editar (PATCH /automations/[id]). Arquivo com `_` na frente: o Next não o trata
 * como rota.
 */
import { z } from "zod";

export const variableSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("fixed"), value: z.string().min(1).max(1024) }),
  z.object({ kind: z.literal("contact_name") }),
  z.object({ kind: z.literal("contact_first_name") }),
  z.object({ kind: z.literal("appointment_date") }),
  z.object({ kind: z.literal("appointment_time") }),
]);
