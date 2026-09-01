import { Link } from "@tanstack/react-router";
import { ChevronDown, CircleUserRound, LogOut, UsersRound } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAuth } from "@/lib/auth";
import { cn } from "@/lib/utils";

export function UserAvatar({ name, size = "default" }: { name: string; size?: "default" | "large" }) {
  return (
    <Avatar className={cn(size === "large" ? "size-10" : "size-8", "rounded-full ring-1 ring-border")}>
      <AvatarFallback className="rounded-full bg-primary text-[11px] font-bold text-primary-foreground">
        {userInitials(name)}
      </AvatarFallback>
    </Avatar>
  );
}

export function AccountMenu({
  collapsed = false,
  onNavigate,
  placement = "sidebar",
}: {
  collapsed?: boolean;
  onNavigate?: () => void;
  placement?: "sidebar" | "header";
}) {
  const { t } = useTranslation();
  const { user, logout, logoutPending } = useAuth();
  const displayName = user?.display_name || t("account.fallbackName");

  async function signOut() {
    try {
      await logout();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("common.unknownError"));
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={t("sidebar.accountMenuFor", { name: displayName })}
          className={cn(
            "group flex h-11 items-center outline-none transition-colors focus-visible:ring-2",
            placement === "header"
              ? "size-11 justify-center rounded-full p-1.5 text-foreground hover:bg-muted focus-visible:ring-ring/40 data-[state=open]:bg-muted data-[state=open]:ring-1 data-[state=open]:ring-border"
              : "rounded-lg text-sidebar-foreground hover:bg-sidebar-accent focus-visible:ring-sidebar-ring data-[state=open]:bg-sidebar-accent",
            collapsed ? "mx-auto size-11 justify-center" : placement === "header" ? "" : "w-full gap-2.5 px-2",
          )}
        >
          <UserAvatar name={displayName} />
          {!collapsed && placement !== "header" ? (
            <>
              <span className="min-w-0 flex-1 text-left">
                <strong className="block truncate text-xs font-semibold text-sidebar-foreground">{displayName}</strong>
                <span className="mt-0.5 block truncate text-[10px] text-sidebar-foreground/50">{t("account.localAccount")}</span>
              </span>
              <ChevronDown className="size-3.5 text-sidebar-foreground/45 transition-transform group-data-[state=open]:rotate-180" />
            </>
          ) : null}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align={placement === "header" ? "end" : collapsed ? "start" : "center"}
        side={placement === "header" ? "bottom" : collapsed ? "right" : "top"}
        className="w-64 rounded-lg"
      >
        <DropdownMenuLabel className="flex items-center gap-3 py-2 font-normal">
          <UserAvatar name={displayName} size="large" />
          <span className="min-w-0">
            <strong className="block truncate text-sm font-semibold text-foreground">{displayName}</strong>
            <span className="mt-0.5 block truncate text-xs text-muted-foreground">{user?.email}</span>
          </span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild className="min-h-11 rounded-md">
          <Link to="/account" onClick={onNavigate}>
            <CircleUserRound />
            {t("account.title")}
          </Link>
        </DropdownMenuItem>
        {user?.role === "admin" ? (
          <DropdownMenuItem asChild className="min-h-11 rounded-md">
            <Link to="/access" onClick={onNavigate}>
              <UsersRound />
              {t("auth.manageUsers")}
            </Link>
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem className="min-h-11 rounded-md" variant="destructive" disabled={logoutPending} onSelect={() => void signOut()}>
          <LogOut />
          {t(logoutPending ? "auth.signingOut" : "auth.signOut")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function userInitials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "U";
  if (parts.length === 1) return Array.from(parts[0]).slice(0, 2).join("").toUpperCase();
  return `${Array.from(parts[0])[0] ?? ""}${Array.from(parts.at(-1) ?? "")[0] ?? ""}`.toUpperCase();
}
