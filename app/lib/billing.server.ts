import type { authenticate } from "../shopify.server";

// Plan -> competitor cap, for Shopify Managed App Pricing (now "Shopify App
// Pricing"). Plans are defined in the Partner Dashboard (app listing ->
// Pricing), NOT in code. This file is the ONE place that maps a plan to what it
// unlocks (the plan's competitor cap), so there is a single source of truth and
// no magic numbers scattered through the gate.
//
// WHY WE KEY ON THE PLAN *HANDLE*, NOT THE DISPLAY NAME:
// activeSubscriptions exposes the plan's `name`, but that name is LOCALIZED per
// merchant -- a Dutch merchant on "Growth" can come back as a translated string,
// which would miss an English key here and silently drop the merchant to
// FREE_CAP. The plan *handle* (the lowercase slug shown above each plan's
// Display Name field in the dashboard: free / starter / growth / unlimited) does
// NOT localize. We read it from
// activeSubscriptions.lineItems.plan.pricingDetails.planHandle (requires API
// version July25+; we are on October25).
//
// The KEYS below MUST match the plan handles byte-for-byte (lowercase slugs).
// The cap values are the plan tiers: free=3, starter=10, growth=25,
// unlimited=UNLIMITED. UNLIMITED is a sentinel, not a literal, so "unlimited"
// can never be off-by-one against a large number.
export const UNLIMITED = Number.POSITIVE_INFINITY;

export const PLAN_CAPS: Record<string, number> = {
  free: 3,
  starter: 10,
  growth: 25,
  unlimited: UNLIMITED,
  "shopify-test": 10, // TEST private plan ($0) -- strip before launch
};

// The cap a merchant gets with no recognized active plan. "No identifiable paid
// plan" must resolve to the free allowance, never to unlimited -- the
// safe-by-default floor. Also the floor when planHandle comes back null (a known
// managed-pricing edge case) -- failing closed is the correct behavior there.
export const FREE_CAP = 3;

// Shape of the object returned by authenticate.admin(request). We need its
// `admin` GraphQL client -- the plan handle only comes from a GraphQL query, not
// from billing.check(). Derived from the real function so we stay correct across
// library minor versions.
type AdminContext = Awaited<ReturnType<typeof authenticate.admin>>;
type AdminApiContext = AdminContext["admin"];

export type PlanInfo = {
  planName: string | null; // the active plan HANDLE, or null if none/unknown
  cap: number; // resolved competitor cap (FREE_CAP when unknown)
  isUnlimited: boolean;
};

// Read the merchant's active plan handle and resolve it to a competitor cap.
//
// activeSubscriptions returns the merchant's current subscriptions; we read the
// recurring plan handle off the first active one. Anything we can't positively
// identify as a known paid handle resolves to the free floor -- failing OPEN on
// a billing read would let a merchant track unlimited competitors for free, so
// we fail CLOSED to FREE_CAP.
export async function getPlanInfo(admin: AdminApiContext): Promise<PlanInfo> {
  let planHandle: string | null = null;

  try {
    const resp = await admin.graphql(
      `#graphql
        query ActivePlanHandle {
          currentAppInstallation {
            activeSubscriptions {
              status
              lineItems {
                plan {
                  pricingDetails {
                    __typename
                    ... on AppRecurringPricing {
                      planHandle
                    }
                  }
                }
              }
            }
          }
        }`,
    );
    const json: any = await resp.json();
    const subs: any[] =
      json?.data?.currentAppInstallation?.activeSubscriptions ?? [];
    const active = subs.find((s) => s?.status === "ACTIVE") ?? subs[0] ?? null;
    // First line item exposing a recurring plan handle wins. (Our plans are
    // single-line-item, but iterate to be safe against multi-line plans.)
    for (const li of active?.lineItems ?? []) {
      const h = li?.plan?.pricingDetails?.planHandle;
      if (typeof h === "string" && h.length > 0) {
        planHandle = h;
        break;
      }
    }
  } catch (e) {
    // A billing read failure must not break the page or silently grant access.
    // Treat it as "unknown plan" -> free floor.
    console.error("plan-handle query failed; defaulting to free cap:", e);
    planHandle = null;
  }

  if (planHandle && planHandle in PLAN_CAPS) {
    const cap = PLAN_CAPS[planHandle];
    return { planName: planHandle, cap, isUnlimited: cap === UNLIMITED };
  }

  return { planName: planHandle, cap: FREE_CAP, isUnlimited: FREE_CAP === UNLIMITED };
}

// Convenience for the gate: given a current tracked count and a cap, can the
// merchant track ONE more? Unlimited always passes. Centralized so the loader
// (for the "8 / 10 tracked" display) and the recheck gate agree exactly.
export function canTrackMore(currentCount: number, cap: number): boolean {
  if (cap === UNLIMITED) return true;
  return currentCount < cap;
}
