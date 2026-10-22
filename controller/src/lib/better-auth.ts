import { createAuthClient } from "better-auth/react";
import { adminClient, inferAdditionalFields } from "better-auth/client/plugins";

export const authClient = createAuthClient({
  baseURL: window.location.origin,
  basePath: "/api/auth",
  plugins: [
    adminClient(),
    inferAdditionalFields({
      user: {
        preferredLanguage: { type: "string", required: false },
        tenantId: { type: "string", required: false },
      },
    }),
  ],
});
