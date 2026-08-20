/// <reference types="vite/client" />

import type { CoilCoilDesktopApi } from "../../shared/desktop-api";

declare global {
  interface Window {
    coilcoil: CoilCoilDesktopApi;
  }
}

export {};

