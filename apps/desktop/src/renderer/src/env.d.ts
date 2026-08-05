/// <reference types="vite/client" />

import type { SuoCodeDesktopApi } from "../../shared/desktop-api";

declare global {
  interface Window {
    suocode: SuoCodeDesktopApi;
  }
}

export {};

