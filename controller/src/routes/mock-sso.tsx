import { useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, Building2, ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth";
import { getMockSsoConfig } from "@/lib/identity-api";
import { mockSsoIdentities, type MockSsoIdentity } from "../../shared/mock-sso";

export function MockSsoPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { loginMockSso, mockSsoPending } = useAuth();
  const config = useQuery({ queryKey: ["mock-sso", "config"], queryFn: getMockSsoConfig, retry: false, staleTime: 60_000 });
  const [identity, setIdentity] = useState<MockSsoIdentity>("tenantA");
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    try {
      await loginMockSso(identity);
      await navigate({ to: "/dashboard", replace: true });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("common.unknownError"));
    }
  }

  return <main className="flex min-h-dvh items-center justify-center bg-muted/30 px-5 py-10">
    <div className="w-full max-w-lg rounded-2xl border bg-card p-7 shadow-sm sm:p-10">
      <div className="flex items-center gap-3 text-primary"><span className="flex size-10 items-center justify-center rounded-xl bg-primary/10"><ShieldCheck className="size-5" /></span><span className="font-semibold">TaskLattice Guard</span></div>
      <div className="mt-10 flex size-12 items-center justify-center rounded-xl bg-primary/10 text-primary"><Building2 className="size-6" /></div>
      <p className="mt-6 text-xs font-semibold uppercase tracking-[0.16em] text-primary">{t("auth.mockSsoEyebrow")}</p>
      <h1 className="mt-2 font-display text-3xl font-semibold">{t("auth.mockSsoTitle")}</h1>
      <p className="mt-3 text-sm leading-6 text-muted-foreground">{t("auth.mockSsoDescription")}</p>

      {config.isLoading ? <p className="mt-8 text-sm text-muted-foreground">{t("auth.mockSsoChecking")}</p>
        : !config.data?.enabled ? <Alert variant="destructive" className="mt-8"><AlertDescription>{t("auth.mockSsoUnavailable")}</AlertDescription></Alert>
          : <form className="mt-8 grid gap-5" onSubmit={submit}>
            <label htmlFor="mock-sso-identity" className="grid gap-2 text-sm font-medium">
              {t("auth.mockSsoIdentity")}
              <select id="mock-sso-identity" value={identity} onChange={(event) => setIdentity(event.target.value as MockSsoIdentity)} className="min-h-11 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                {mockSsoIdentities.map((option) => <option key={option.id} value={option.id}>{option.tenantId} ({option.group})</option>)}
              </select>
            </label>
            {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
            <Button type="submit" size="lg" className="min-h-11 w-full" disabled={mockSsoPending}>{mockSsoPending ? t("auth.loginSubmitting") : t("auth.mockSsoSignIn")}</Button>
          </form>}
      <Link to="/dashboard" className="mt-8 inline-flex min-h-11 items-center gap-2 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="size-4" />{t("auth.mockSsoBack")}</Link>
    </div>
  </main>;
}
