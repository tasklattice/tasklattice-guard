import { useState, type FormEvent } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Building2, LockKeyhole } from "lucide-react";
import { useTranslation } from "react-i18next";

import { BrandLogo } from "@/components/brand-logo";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useAuth } from "@/lib/auth";
import type { SupportedLanguage } from "@/i18n";

export function LoginPage() {
  const { t, i18n } = useTranslation();
  const { login, setLanguage, loginPending } = useAuth();
  const navigate = useNavigate();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    try {
      await login({ username, password });
      await navigate({ to: "/dashboard", replace: true });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("common.unknownError"));
    }
  }

  return (
    <main className="relative grid min-h-dvh bg-background lg:grid-cols-[minmax(340px,0.85fr)_minmax(540px,1.15fr)]">
      <section className="relative hidden overflow-hidden border-r bg-primary px-10 py-12 text-primary-foreground lg:flex lg:flex-col lg:justify-between xl:px-14">
        <div className="absolute inset-0 opacity-20 [background-image:linear-gradient(to_right,white_1px,transparent_1px),linear-gradient(to_bottom,white_1px,transparent_1px)] [background-size:48px_48px]" />
        <div className="relative flex items-center gap-3">
          <BrandLogo onPrimary />
        </div>
        <div className="relative max-w-lg">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-white/65">{t("auth.brandEyebrow")}</p>
          <h2 className="mt-4 font-sans text-4xl font-normal leading-tight tracking-[-0.02em] xl:text-5xl">{t("auth.brandTitle")}</h2>
          <div className="mt-8 flex items-center gap-3 text-sm text-white/70"><Building2 className="size-4" />{t("auth.brandDescription")}</div>
        </div>
        <p className="relative text-xs text-white/55">{t("auth.brandFootnote")}</p>
      </section>

      <section className="flex min-h-dvh flex-col px-5 py-5 sm:px-8 lg:px-12 lg:py-8">
        <div className="flex justify-end">
          <Select value={languageValue(i18n.language)} onValueChange={(value) => void setLanguage(value as SupportedLanguage)}>
            <SelectTrigger aria-label={t("common.language")} className="w-40 field:h-12"><SelectValue /></SelectTrigger>
            <SelectContent position="popper" align="end"><SelectItem value="en">{t("common.english")}</SelectItem><SelectItem value="zh-CN">{t("common.chinese")}</SelectItem></SelectContent>
          </Select>
        </div>
        <div className="flex flex-1 items-center justify-center py-10">
          <div className="w-full max-w-md">
            <div className="mb-8 lg:hidden"><BrandLogo /></div>
            <span className="inline-flex size-11 items-center justify-center rounded-xl bg-primary/10 text-primary"><LockKeyhole className="size-5" /></span>
            <p className="mt-6 text-sm font-medium text-primary">{t("auth.loginEyebrow")}</p>
            <h1 className="mt-2 font-sans text-3xl font-normal tracking-normal">{t("auth.loginTitle")}</h1>
            <p className="mt-3 text-sm leading-6 text-muted-foreground">{t("auth.loginDescription")}</p>

            <form className="mt-8 grid gap-5" onSubmit={submit}>
              <Field label={t("auth.loginIdentifier")}><Input className="field:min-h-[44px]" autoFocus type="text" autoComplete="username" placeholder="admin" value={username} onChange={(event) => setUsername(event.target.value)} required /></Field>
              <Field label={t("common.password")}><Input className="field:min-h-[44px]" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required /></Field>
              {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
              <Button type="submit" size="lg" className="mt-1 min-h-[44px] w-full" disabled={loginPending}>{loginPending ? t("auth.loginSubmitting") : t("auth.loginSubmit")}</Button>
            </form>

          </div>
        </div>
      </section>
    </main>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return <label className="grid gap-2 text-sm font-medium">{label}{children}{hint ? <span className="text-xs font-normal text-muted-foreground">{hint}</span> : null}</label>;
}

function languageValue(language: string): SupportedLanguage {
  return language.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}
