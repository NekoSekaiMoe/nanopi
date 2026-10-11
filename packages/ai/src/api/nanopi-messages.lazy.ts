import type { ProviderStreams } from "../types.ts";
import { lazyApi } from "./lazy.ts";

export const nanopiMessagesApi = (): ProviderStreams => lazyApi(() => import("./nanopi-messages.ts"));
