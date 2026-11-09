import { useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { PasswordInput } from "@carbon/react";
import { getPasswordPolicy } from "@/lib/identity-api";
import { passwordMeetsPolicy, type PasswordPolicy } from "../../shared/password-policy";
import { ErrorNotice } from "./product-shell";
import { Button } from "./ui/button";

export function usePasswordPolicy(enabled = true) {
  return useQuery({ queryKey: ["password-policy"], queryFn: getPasswordPolicy, enabled, retry: false });
}

export function PasswordPolicyNotice({ query }: { query: ReturnType<typeof usePasswordPolicy> }) {
  const { t } = useTranslation();
  if (query.isError) return <div><ErrorNotice error={query.error} /><Button variant="link" onClick={() => void query.refetch()}>{t("accountForm.retry")}</Button></div>;
  if (query.isPending) return <p role="status" className="text-sm text-muted-foreground">{t("accountForm.policyLoading")}</p>;
  return null;
}

export function AccountPasswordField({ label, value, onChange, policy, optional = false, disabled = false }: {
  label: string; value: string; onChange: (value: string) => void;
  policy?: PasswordPolicy; optional?: boolean; disabled?: boolean;
}) {
  const id = useId();
  const { t } = useTranslation();
  const [touched, setTouched] = useState(false);
  const invalid = touched && Boolean(policy) && !(optional && !value) && !passwordMeetsPolicy(value, policy!);
  const requirement = policy ? t("accountForm.passwordHint", policy) : t("accountForm.policyLoading");
  return <PasswordInput id={id} labelText={label} size="md" value={value}
    autoComplete="new-password" disabled={disabled || !policy} required={!optional}
    minLength={policy?.minLength} maxLength={policy?.maxLength}
    onChange={event => onChange(event.target.value)} onBlur={() => setTouched(true)}
    invalid={invalid} invalidText={requirement}
    helperText={`${requirement}${optional ? ` ${t("users.resetHint")}` : ""}`}
    showPasswordLabel={t("accountForm.showPassword")} hidePasswordLabel={t("accountForm.hidePassword")}
  />;
}
