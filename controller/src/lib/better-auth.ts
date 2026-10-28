import { createAuthClient } from "better-auth/react";
import { adminClient, usernameClient, inferAdditionalFields } from "better-auth/client/plugins";

export const authClient = createAuthClient({
  baseURL: window.location.origin,
  basePath: "/api/auth",
  plugins: [
    adminClient(),
    usernameClient({ displayUsername: false }),
    inferAdditionalFields({
      user: {
        preferredLanguage: { type: "string", required: false },
      },
    }),
  ],
});
