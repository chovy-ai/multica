/// <reference types="vite/client" />

import { AgentHostPreloadApi } from "../preload/types/globals";

declare global {
  interface Window {
    agentHostApi: AgentHostPreloadApi;
  }
}
