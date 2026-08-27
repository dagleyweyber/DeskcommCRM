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
import { useConnectMetaAdsReadToken } from "@/hooks/integrations/useMetaAdsCredentials";

const formSchema = z.object({
  ads_read_token: z.string().trim().min(8, "Token muito curto").max(2048),
});
type FormValues = z.infer<typeof formSchema>;

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ConnectAdsReadTokenDialog({ open, onOpenChange }: Props) {
  const router = useRouter();
  const connect = useConnectMetaAdsReadToken();
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | undefined>();

  const reset = () => {
    setToken("");
    setError(undefined);
  };

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(undefined);

    const parsed = formSchema.safeParse({ ads_read_token: token });
    if (!parsed.success) {
      setError(parsed.error.flatten().fieldErrors.ads_read_token?.[0]);
      return;
    }

    try {
      await connect.mutateAsync(parsed.data);
      toast.success("Leitura de campanha conectada.");
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
          <DialogTitle>Conectar leitura de campanha</DialogTitle>
          <DialogDescription>
            Token de um Usuário do Sistema com escopo <code>ads_read</code> ou{" "}
            <code>ads_management</code> na conta de anúncios — diferente do token de
            Purchase acima. Usado só pra descobrir de qual campanha e conjunto cada
            anúncio faz parte.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="meta-ads-read-token">Token de leitura</Label>
            <Input
              id="meta-ads-read-token"
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="EAAG..."
              autoComplete="off"
              required
            />
            {error && <p className="text-xs text-destructive">{error}</p>}
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
