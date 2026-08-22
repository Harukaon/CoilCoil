import { join } from "node:path";

export const LIGHT_APP_ICON = "icon-light.png";
export const DARK_APP_ICON = "icon-dark.png";

export function appIconFilename(dark: boolean): string {
  return dark ? DARK_APP_ICON : LIGHT_APP_ICON;
}

export function appIconPath({
  dark,
  packaged,
  resourcesPath,
  mainDirectory,
}: {
  dark: boolean;
  packaged: boolean;
  resourcesPath: string;
  mainDirectory: string;
}): string {
  const filename = appIconFilename(dark);
  return packaged
    ? join(resourcesPath, "icons", filename)
    : join(mainDirectory, "../../build", filename);
}
