import { useEffect, useState, type FormEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import { KeyRound, Languages, ShieldCheck, UserRound } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { UserAvatar } from "@/components/account-menu";
import { ChangePasswordSheet } from "@/components/change-password-sheet";
import { ConfirmationSheet } from "@/components/confirmation-sheet";
import { PageHeader } from "@/components/product-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { SupportedLanguage } from "@/i18n";
import { useAuth } from "@/lib/auth";

export function AccountPage() {
  const { t, i18n } = useTranslation();
  const { user, updateProfile } = useAuth();
  const [displayName, setDisplayName] = useState(user?.display_name ?? "");
  const [language, setLanguage] = useState<SupportedLanguage>(user?.preferred_language ?? "en");
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  useEffect(() => {
    setDisplayName(user?.display_name ?? "");
    setLanguage(user?.preferred_language ?? "en");
  }, [user?.display_name, user?.preferred_language]);

  const mutation = useMutation({
    mutationFn: () => updateProfile({ display_name: displayName.trim(), preferred_language: language }),
    onSuccess: () => { setConfirmOpen(false); toast.success(t("account.saved")); },
    onError: (error) => toast.error(error instanceof Error ? error.message : t("common.unknownError")),
  });

  if (!user) return null;

  const dirty = displayName.trim() !== user.display_name || language !== user.preferred_language;
  const formatDate = (value: string) => new Intl.DateTimeFormat(i18n.language, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (displayName.trim() && dirty) setConfirmOpen(true);
  }

  return (
    <section className="py-6 sm:py-8">
      <PageHeader title={t("account.title")} description={t("account.description")} />

      <Tabs defaultValue="general" className="mt-6">
        <TabsList aria-label={t("account.sections")}>
          <TabsTrigger value="general"><UserRound />{t("account.general")}</TabsTrigger>
          <TabsTrigger value="security"><KeyRound />{t("account.security")}</TabsTrigger>
        </TabsList>

        <TabsContent value="general" className="mt-5">
          <div className="grid max-w-5xl gap-5 lg:grid-cols-[minmax(0,1.35fr)_minmax(280px,0.65fr)]">
            <Card>
              <CardHeader className="border-b">
                <CardTitle>{t("account.profile")}</CardTitle>
                <CardDescription>{t("account.profileDescription")}</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="mb-6 flex items-center gap-3 rounded-xl border bg-muted/25 p-4">
                  <UserAvatar name={user.display_name} size="large" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold">{user.display_name}</p>
                    <p className="mt-0.5 truncate text-xs text-muted-foreground">{user.email}</p>
                  </div>
                  <Badge variant="outline" className="gap-1.5 font-normal">
                    <ShieldCheck className="text-primary" />
                    {t(user.role === "admin" ? "common.admin" : "common.member")}
                  </Badge>
                </div>

                <form className="grid gap-5" onSubmit={submit}>
                  <div className="grid gap-2">
                    <Label htmlFor="account-display-name">{t("account.displayName")}</Label>
                    <Input id="account-display-name" autoComplete="name" value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
                    <p className="text-xs leading-5 text-muted-foreground">{t("account.displayNameHint")}</p>
                  </div>

                  <div className="grid gap-2">
                    <Label htmlFor="account-email">{t("account.email")}</Label>
                    <Input id="account-email" type="email" value={user.email} readOnly aria-readonly />
                    <p className="text-xs leading-5 text-muted-foreground">{t("account.emailReadOnly")}</p>
                  </div>

                  <div className="grid gap-2">
                    <Label htmlFor="account-language">{t("account.interfaceLanguage")}</Label>
                    <Select value={language} onValueChange={(value) => setLanguage(value as SupportedLanguage)}>
                      <SelectTrigger id="account-language" className="max-w-sm">
                        <Languages className="text-muted-foreground" />
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="en">{t("common.english")}</SelectItem>
                        <SelectItem value="zh-CN">{t("common.chinese")}</SelectItem>
                      </SelectContent>
                    </Select>
                    <p className="text-xs leading-5 text-muted-foreground">{t("account.languageDescription")}</p>
                  </div>

                  <div className="flex justify-end border-t pt-5">
                    <Button type="submit" disabled={!displayName.trim() || !dirty || mutation.isPending}>
                      {mutation.isPending ? t("common.saving") : t("account.saveChanges")}
                    </Button>
                  </div>
                </form>
              </CardContent>
            </Card>

            <Card className="self-start">
              <CardHeader className="border-b">
                <CardTitle>{t("account.roleAccess")}</CardTitle>
                <CardDescription>{t("account.roleAccessDescription")}</CardDescription>
              </CardHeader>
              <CardContent>
                <dl className="divide-y text-sm">
                  <AccountFact label={t("account.accountRole")} value={t(user.role === "admin" ? "common.admin" : "common.member")} />
                  <AccountFact label={t("account.accountStatus")} value={t(user.enabled ? "account.active" : "common.disabled")} />
                  <AccountFact label={t("account.lastSignIn")} value={user.last_login_at ? formatDate(user.last_login_at) : t("common.never")} />
                  <AccountFact label={t("account.created")} value={formatDate(user.created_at)} />
                </dl>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="security" className="mt-5">
          <Card className="max-w-3xl">
            <CardHeader className="border-b">
              <CardTitle>{t("account.securityTitle")}</CardTitle>
              <CardDescription>{t("account.securityDescription")}</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex flex-col gap-4 rounded-xl border bg-muted/25 p-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex gap-3">
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary"><KeyRound className="size-4.5" /></span>
                  <div>
                    <p className="text-sm font-medium">{t("account.password")}</p>
                    <p className="mt-1 max-w-xl text-xs leading-5 text-muted-foreground">{t("account.passwordManagedLocally")}</p>
                  </div>
                </div>
                <Button variant="outline" onClick={() => setPasswordOpen(true)}><KeyRound />{t("auth.changePassword")}</Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <ChangePasswordSheet open={passwordOpen} onOpenChange={setPasswordOpen} />
      <ConfirmationSheet
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        eyebrow={t("account.confirmEyebrow")}
        title={t("account.confirmTitle")}
        description={t("account.confirmDescription")}
        cancelLabel={t("common.cancel")}
        confirmLabel={t("account.saveChanges")}
        pendingLabel={t("common.saving")}
        pending={mutation.isPending}
        onConfirm={() => mutation.mutate()}
      >
        <dl className="divide-y rounded-lg border bg-card px-4 text-sm">
          <AccountFact label={t("account.displayName")} value={displayName.trim()} />
          <AccountFact label={t("account.interfaceLanguage")} value={t(language === "zh-CN" ? "common.chinese" : "common.english")} />
        </dl>
        {mutation.error ? <p role="alert" className="rounded-lg border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive">{mutation.error instanceof Error ? mutation.error.message : t("common.unknownError")}</p> : null}
      </ConfirmationSheet>
    </section>
  );
}

function AccountFact({ label, value }: { label: string; value: string }) {
  return <div className="flex items-start justify-between gap-4 py-3 first:pt-0 last:pb-0"><dt className="text-muted-foreground">{label}</dt><dd className="text-right font-medium text-foreground">{value}</dd></div>;
}
