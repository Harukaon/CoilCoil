import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createSubscriptionProvider, readSubscriptionAccounts } from "./subscription-accounts.ts";

/** Headless workers use the same named subscription accounts as the desktop. */
export default function subscriptionAccountsExtension(pi: ExtensionAPI): void {
  for (const account of readSubscriptionAccounts(getAgentDir())) {
    pi.registerProvider(createSubscriptionProvider(account));
  }
}
