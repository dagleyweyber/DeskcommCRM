"use client";
import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { z } from "zod";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useConnectMetaAds } from "@/hooks/integrations/useMetaAdsCredentials";

const formSchema = z.object({
  access_token: z.string().trim().min(8, "Token muito curto").max(2048),
  dataset_id: z.string().trim().min(1, "Obrigatório").max(60),
});
type FormValues = z.infer<typeof formSchema>;

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ConnectMetaAdsDialog({ open, onOpenChange }: Props) {
  const router = useRouter();
  const connect = useConnectMetaAds();
  const [accessToken, setAccessToken] = useState("");
  const [datasetId, setDatasetId] = useState("");
  const [errors, setErrors] = useState<Partial<Record<keyof FormValues, string>>>({});

  const reset = () => {
    setAccessToken("");
    setDatasetId("");
    setErrors({});
  };

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setErrors({});

    const parsed = formSchema.safeParse({ access_token: accessToken, dataset_id: datasetId });
    if (!parsed.success) {
      const flat = parsed.error.flatten().fieldErrors;
      setErrors({ access_token: flat.access_token?.[0], dataset_id: flat.dataset_id?.[0] });
      return;
    }

    try {
      await connect.mutateAsync(parsed.data);
      toast.success("Meta Ads conectado — vendas passam a ser enviadas automaticamente.");
      reset();
      onOpenChange(false);
      router.refresh();
    } catch {
      // erro já mostrado pelo toast do hook
    }
  };

  const onOpenChangeWrapped = (next: boolean) => {
    if (!next) reset();
    onOpenChange(next);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChangeWrapped}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Conectar Meta Ads</DialogTitle>
          <DialogDescription>
            Token e Dataset ID vêm do Gerenciador de Eventos do Meta Business. O
            token é cifrado antes de gravar e nunca é mostrado de volta.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="meta-ads-token">Token de acesso</Label>
            <Input
              id="meta-ads-token"
              type="password"
              value={accessToken}
              onChange={(e) => setAccessToken(e.target.value)}
              placeholder="EAAG..."
              autoComplete="off"
              required
            />
            {errors.access_token && (
              <p className="text-xs text-destructive">{errors.access_token}</p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="meta-ads-dataset">Dataset ID (ou Pixel ID)</Label>
            <Input
              id="meta-ads-dataset"
              value={datasetId}
              onChange={(e) => setDatasetId(e.target.value)}
              placeholder="Ex: 1234567890"
              required
            />
            {errors.dataset_id && (
              <p className="text-xs text-destructive">{errors.dataset_id}</p>
            )}
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChangeWrapped(false)}
              disabled={connect.isPending}
            >
              Cancelar
            </Button>
            <Button type="submit" disabled={connect.isPending}>
              {connect.isPending ? "Conectando…" : "Conectar"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
