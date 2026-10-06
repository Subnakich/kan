import type { BetterAuthClientPlugin } from "better-auth";
import type { BetterFetchOption } from "better-auth/react";
import type { ReactAuthClient } from "better-auth/react";
import { apiKeyClient } from "@better-auth/api-key/client";
import { stripeClient } from "@better-auth/stripe/client";
import {
  genericOAuthClient,
  magicLinkClient,
} from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

import type { socialProvidersPlugin } from "./providers";

const socialProvidersPluginClient = {
  id: "social-providers-plugin",
  $InferServerPlugin: {} as ReturnType<typeof socialProvidersPlugin>,
  getActions: ($fetch) => {
    return {
      getSocialProviders: async (fetchOptions?: BetterFetchOption) => {
        const res = $fetch("/social-providers", {
          method: "GET",
          ...fetchOptions,
        });
        return res.then((res) => res.data as string[]);
      },
    };
  },
} satisfies BetterAuthClientPlugin;

type KanAuthClientOptions = {
  plugins: (
    | ReturnType<typeof stripeClient<{ subscription: true }>>
    | ReturnType<typeof magicLinkClient>
    | ReturnType<typeof apiKeyClient>
    | ReturnType<typeof genericOAuthClient>
    | typeof socialProvidersPluginClient
  )[];
};

export const authClient: ReactAuthClient<KanAuthClientOptions> =
  createAuthClient({
    plugins: [
      stripeClient({
        subscription: true,
      }),
      magicLinkClient(),
      apiKeyClient(),
      genericOAuthClient(),
      socialProvidersPluginClient,
    ],
  });
