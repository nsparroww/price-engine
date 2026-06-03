import type { authenticate } from "../shopify.server";

// Plan -> competitor cap, for Shopify Managed App Pricing.
//
// Managed pricing means plans are defined in the Partner Dashboard (App ->
// Pricing), NOT in code or shopify.app.toml. The library still exposes the
// active plan name via `billing.check`. This file is the ONE place that maps
// those plan names to what they unlock (the Â§7 competitor cap), so there is a
// single source of truth and no magic numbers scattered through the gate.
//
// >>> FILL THIS IN <<<
// The KEYS below must match the plan names you create in the Partner Dashboard
// BYTE-FOR-BYTE (case, spacing, punctuation). `billing.check` returns the plan
// name as a string; if it doesn't match a key here, the merchant silently falls
// back to FREE_CAP. After creating the plans, set these four keys to the exact
// names shown in the dashboard. The cap values are the Â§7 tiers:
//   Free = 3, $29 = 10, $59 = 25, $99 = unlimited.
// UNLIMITED is a sentinel, not a real number, so "unlimited" can never be
// off-by-one against a large literal.
export const UNLIMITED = Number.POSITIVE_INFINITY;

export const PLAN_CAPS: Record<string, number> = {
  // "<exact Free plan name>": 3,
  // "<exact $29 plan name>": 10,
  // "<exact $59 plan name>": 25,
  // "<exact $99 plan name>": UNLIMITED,
};

// The cap a merchant gets with no active paid subscription. Managed pricing's
// free tier may or may not surface as a named plan in `billing.check`; either
// way, "no recognized active plan" must resolve to the free allowance, never to
// unlimited. This is the safe-by-default floor.
export const FREE_CAP = 3;

// Shape of the object returned by `authenticate.admin(request)`. We only need
// its `billing` member, so we derive the type from the real function rather
// than hand-rolling it (keeps us correct across library minor versions).
type AdminContext = Awaited<ReturnType<typeof authenticate.admin>>;
type BillingContext = AdminContext["billing"];

export type PlanInfo = {
  planName: string | null; // the active plan's name, or null if none/unknown
  cap: number; // resolved competitor cap (FREE_CAP when unknown)
  isUnlimited: boolean;
};

// Read the merchant's active plan and resolve it to a competitor cap.
//
// `billing.check()` with no `plans` filter returns the merchant's current
// subscriptions. We take the first active subscription's name and look it up in
// PLAN_CAPS. Anything we can't positively identify as a paid plan resolves to
// the free floor -- failing OPEN to "more access" on a billing read would let a
// merchant track unlimited competitors for free, so we fail CLOSED to FREE_CAP.
export async function getPlanInfo(billing: BillingContext): Promise<PlanInfo> {
  let planName: string | null = null;

  try {
    // No `plans` argument => "what does this merchant currently have?" rather
    // than "do they have plan X?". We read the name off the first active sub.
    const result: any = await billing.check();
    const subs: any[] = result?.appSubscriptions ?? [];
    const active = subs.find((s) => s?.status === "ACTIVE") ?? subs[0] ?? null;
    planName = active?.name ?? null;
  } catch (e) {
    // A billing read failure must not break the page or silently grant access.
    // Treat it as "unknown plan" -> free floor.
    console.error("billing.check failed; defaulting to free cap:", e);
    planName = null;
  }

  if (planName && planName in PLAN_CAPS) {
    const cap = PLAN_CAPS[planName];
    return { planName, cap, isUnlimited: cap === UNLIMITED };
  }

  return { planName, cap: FREE_CAP, isUnlimited: FREE_CAP === UNLIMITED };
}

// Convenience for the gate: given a current tracked count and a cap, can the
// merchant track ONE more? Unlimited always passes. Centralized so the loader
// (for the "8 / 10 tracked" display) and the recheck gate agree exactly.
export function canTrackMore(currentCount: number, cap: number): boolean {
  if (cap === UNLIMITED) return true;
  return currentCount < cap;
}
