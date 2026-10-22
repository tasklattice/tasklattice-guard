import { createContext, useCallback, useContext, useEffect, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import i18n, { setApplicationLanguage, type SupportedLanguage } from "@/i18n";
import {
  getAuthStatus,
  loginMockSso as loginMockSsoRequest,
  login as loginRequest,
  logout as logoutRequest,
  updateMe,
  type AuthStatus,
  type IdentityUser,
} from "@/lib/identity-api";
import { queryKeys } from "@/features/query-keys";
import type { MockSsoIdentity } from "../../shared/mock-sso";

type LoginInput = { email: string; password: string };
type ProfileInput = {
  display_name?: string;
  preferred_language?: SupportedLanguage;
};

type AuthContextValue = {
  status: AuthStatus | undefined;
  user: IdentityUser | null;
  isLoading: boolean;
  error: unknown;
  login: (input: LoginInput) => Promise<void>;
  loginMockSso: (identity: MockSsoIdentity) => Promise<void>;
  logout: () => Promise<void>;
  setLanguage: (language: SupportedLanguage) => Promise<void>;
  updateProfile: (input: ProfileInput) => Promise<void>;
  loginPending: boolean;
  mockSsoPending: boolean;
  logoutPending: boolean;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const clearChangedIdentity = useCallback(async (next: AuthStatus) => {
    const previous = queryClient.getQueryData<AuthStatus>(queryKeys.auth);
    if (
      previous?.authenticated === next.authenticated
      && previous?.user?.id === next.user?.id
      && previous?.user?.role === next.user?.role
      && previous?.user?.tenant_id === next.user?.tenant_id
      && previous?.user?.enabled === next.user?.enabled
    ) return;

    // Keep the session query itself alive; all other cached resources belong
    // to the prior authority, including the separate identity/users query.
    const resources = { predicate: (query: { queryKey: readonly unknown[] }) =>
      query.queryKey.length !== queryKeys.auth.length
      || query.queryKey.some((part, index) => part !== queryKeys.auth[index]) };
    await queryClient.cancelQueries(resources);
    queryClient.removeQueries(resources);
    queryClient.getMutationCache().clear();
  }, [queryClient]);

  const statusQuery = useQuery({
    queryKey: queryKeys.auth,
    queryFn: async ({ signal }) => {
      const next = await getAuthStatus();
      if (signal.aborted) throw new Error("Session refresh cancelled.");
      await clearChangedIdentity(next);
      return next;
    },
    staleTime: 30_000,
    retry: false,
  });

  const setAuthenticatedUser = useCallback(async (user: IdentityUser) => {
    await queryClient.cancelQueries({ queryKey: queryKeys.auth, exact: true });
    const next: AuthStatus = { authenticated: true, user };
    await clearChangedIdentity(next);
    queryClient.setQueryData<AuthStatus>(queryKeys.auth, next);
  }, [clearChangedIdentity, queryClient]);

  const loginMutation = useMutation({
    mutationFn: loginRequest,
    onSuccess: ({ user }) => setAuthenticatedUser(user),
  });
  const mockSsoMutation = useMutation({
    mutationFn: loginMockSsoRequest,
    onSuccess: ({ user }) => setAuthenticatedUser(user),
  });
  const logoutMutation = useMutation({
    mutationFn: logoutRequest,
    onSettled: () => {
      queryClient.clear();
      queryClient.setQueryData<AuthStatus>(queryKeys.auth, {
        authenticated: false,
        user: null,
      });
    },
  });

  const user = statusQuery.data?.user ?? null;

  useEffect(() => {
    if (user?.preferred_language && user.preferred_language !== i18n.language) {
      void setApplicationLanguage(user.preferred_language);
    }
  }, [user?.preferred_language]);

  useEffect(() => {
    const handleUnauthorized = () => void queryClient.invalidateQueries({ queryKey: queryKeys.auth });
    window.addEventListener("tasklattice:unauthorized", handleUnauthorized);
    return () => window.removeEventListener("tasklattice:unauthorized", handleUnauthorized);
  }, [queryClient]);

  const setLanguage = useCallback(async (language: SupportedLanguage) => {
    if (!user) {
      await setApplicationLanguage(language);
      return;
    }
    const result = await updateMe({ preferred_language: language });
    await setAuthenticatedUser(result.user);
    await setApplicationLanguage(result.user.preferred_language);
  }, [setAuthenticatedUser, user]);

  const updateProfile = useCallback(async (input: ProfileInput) => {
    if (!user) return;
    const result = await updateMe(input);
    await setAuthenticatedUser(result.user);
    if (
      input.preferred_language
      && result.user.preferred_language !== i18n.language
    ) {
      await setApplicationLanguage(result.user.preferred_language);
    }
  }, [setAuthenticatedUser, user]);

  return (
    <AuthContext.Provider
      value={{
        status: statusQuery.data,
        user,
        isLoading: statusQuery.isLoading,
        error: statusQuery.error,
        login: async (input) => { await loginMutation.mutateAsync(input); },
        loginMockSso: async (identity) => { await mockSsoMutation.mutateAsync(identity); },
        logout: async () => { await logoutMutation.mutateAsync(); },
        setLanguage,
        updateProfile,
        loginPending: loginMutation.isPending,
        mockSsoPending: mockSsoMutation.isPending,
        logoutPending: logoutMutation.isPending,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used within AuthProvider.");
  return value;
}
