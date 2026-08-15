export function isBrowserViewVisible(active: boolean, covered: boolean, documentVisible: boolean): boolean {
  return active && !covered && documentVisible;
}
