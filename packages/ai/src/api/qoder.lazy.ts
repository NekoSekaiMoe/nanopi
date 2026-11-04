import type { ProviderStreams } from "../types.ts";
import { lazyApi } from "./lazy.ts";

export const qoderApi = (): ProviderStreams => lazyApi(() => import("./qoder.ts"));
