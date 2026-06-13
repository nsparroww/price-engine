import prisma from "../db.server";
import { decideAlerts } from "./alerts";
import { UNLIMITED } from "./billing.server";

// The local Python engine service (serve.py). Server-side call only.
export const ENGINE_URL = process.env.ENGINE_URL ?? "http://127.0.0.1:8787";

// Shared secret for the engine's POST routes. Sent on every engine call as the
// X-Engine-Secret header. Unset locally (serve.py runs open on 127.0.0.1) -> no
// header, which is correct: the local engine doesn't enforce. Set in production
// (Vercel env) so that, once the deployed engine has the matching RECHECK_SECRET
// configured, it accepts our calls and 401s everyone else. The two sides must
// hold the SAME value.
const ENGINE_SECRET = process.env.RECHECK_SECRET ?? "";

// Build the headers for an engine call. Always JSON; attach the secret only
// when one is configured, so local dev (no secret) sends a bare Content-Type
// and production sends the shared secret.
function engineHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (ENGINE_SECRET) headers["X-Engine-Secret"] = ENGINE_SECRET;
  return headers;
}

export type RecheckResult = {
  result: any;
  error: string | null;
  saved: boolean;
  // Plan-cap signal. Set only when a NEW competitor was blocked because the
  // shop is at its plan limit. The UI uses `atLimit` to show an upgrade prompt
  // instead of treating it as a generic error; `tracked`/`cap` populate the
  // "10 / 10" message. Undefined on every normal path.
  atLimit?: boolean;
  tracked?: number;
  cap?: number;
};

// Merchant decisions the engine must never overwrite on a re-check. Once a
// human confirms or rejects a match, that verdict sticks regardless of what
// the matcher computes on later runs.
const MERCHANT_LOCKED = new Set(["confirmed", "rejected"]);

// The one proven path: given a merchant product and a competitor URL, ask the
// engine for a match decision, then persist it (upsert a Match, append an
// Observation, and emit any Alert the new reading triggers). Called by the app
// action (manual "Check" / "Re-check") AND by the scheduler (background
// re-check) so the two can never drift.
//
// It is the caller's job to supply `merchant` (the full product object the
// engine matches against). The UI gets it from the live catalog; the scheduler
// rebuilds it from the identifier fields persisted on the Match row below.
//
// `cap` (optional) is the plan's competitor limit. The UI action resolves it
// from billing and passes it so a NEW competitor over the limit is blocked
// before persist. The scheduler passes nothing (undefined) -> no gate, because
// it only re-checks rows that are ALREADY tracked (already within whatever cap
// applied when they were added); re-checking them can't exceed the limit, and
// gating the scheduler would need a Shopify session it doesn't have.
export async function recheckMatch(params: {
  shop: string;
  merchant: Record<string, unknown>;
  competitorUrl: string;
  cap?: number;
}): Promise<RecheckResult> {
  const { shop, merchant, competitorUrl, cap } = params;

  if (!competitorUrl) {
    return { result: null, error: "Enter a competitor product URL.", saved: false };
  }

  // 1) Ask the engine for a match decision.
  let result: any = null;
  try {
    const res = await fetch(`${ENGINE_URL}/match`, {
      method: "POST",
      headers: engineHeaders(),
      body: JSON.stringify({
        merchant,
        candidates: [{ url: competitorUrl }],
      }),
    });
    const data = (await res.json()) as any;
    if (data.error) return { result: null, error: data.error, saved: false };
    result = data.results?.[0] ?? null;
  } catch (e: any) {
    return {
      result: null,
      error: `Could not reach the engine service at ${ENGINE_URL}. Is "python serve.py" running? (${e?.message ?? e})`,
      saved: false,
    };
  }

  if (!result) {
    return { result: null, error: "The engine returned no result for that URL.", saved: false };
  }

  // 2) Persist the decision (a Match) and, if we're tracking it, a price reading
  //    (an Observation). A DB failure here must not hide a good match from the
  //    merchant, so this is isolated and the result is returned either way.
  let saved = false;
  try {
    const productGid = String((merchant as any).id ?? "");
    const productTitle = String((merchant as any).title ?? "(untitled)");
    // Merchant identifiers snapshot - lets the unattended scheduler rebuild the
    // merchant object with no Shopify session. Coerce "" / undefined to null.
    const productBrand = (merchant as any).brand ? String((merchant as any).brand) : null;
    const productGtin = (merchant as any).gtin ? String((merchant as any).gtin) : null;
    const productSku = (merchant as any).sku ? String((merchant as any).sku) : null;
    let competitorHost: string | null = null;
    try {
      competitorHost = new URL(competitorUrl).host;
    } catch {
      competitorHost = null;
    }

    if (productGid) {
      // Is there already a row, and has the merchant locked its status? If so
      // we keep their verdict and ignore the engine's fresh status. Otherwise
      // the engine's status applies (auto / needs_review still move freely).
      const existing = await prisma.match.findUnique({
        where: {
          shop_productGid_competitorUrl: { shop, productGid, competitorUrl },
        },
        select: { status: true },
      });

      const engineStatus = String(result.status ?? "auto");
      const lockedStatus =
        existing && MERCHANT_LOCKED.has(existing.status)
          ? existing.status
          : engineStatus;

      // --- Plan-cap gate --------------------------------------------------
      // Block ONLY when ALL of these hold:
      //   (a) a cap was supplied (UI path; scheduler omits it),
      //   (b) this is a NEW competitor for the shop (no existing row -- a
      //       re-check of a tracked row is already counted, never blocked),
      //   (c) the engine wants to TRACK it (status != rejected -- a rejected
      //       decision consumes no slot and must always persist for audit),
      //   (d) the shop is already AT the cap.
      // When blocked, we DON'T persist, but we DO return the full match result
      // so the merchant still sees that matching worked -- only tracking is
      // gated. `atLimit` tells the UI to show the upgrade prompt.
      const isNewCompetitor = existing == null;
      const wouldTrack = lockedStatus !== "rejected";
      if (cap != null && cap !== UNLIMITED && isNewCompetitor && wouldTrack) {
        const trackedCount = await prisma.match.count({
          where: { shop, status: { not: "rejected" } },
        });
        if (trackedCount >= cap) {
          return {
            result,
            error: null,
            saved: false,
            atLimit: true,
            tracked: trackedCount,
            cap,
          };
        }
      }
      // --------------------------------------------------------------------

      const match = await prisma.match.upsert({
        where: {
          shop_productGid_competitorUrl: { shop, productGid, competitorUrl },
        },
        update: {
          productTitle,
          productBrand,
          productGtin,
          productSku,
          competitorHost,
          confidence: Number(result.confidence ?? 0),
          method: String(result.method ?? ""),
          status: lockedStatus,
        },
        create: {
          shop,
          productGid,
          productTitle,
          productBrand,
          productGtin,
          productSku,
          competitorUrl,
          competitorHost,
          confidence: Number(result.confidence ?? 0),
          method: String(result.method ?? ""),
          status: engineStatus,
        },
      });

      // The status the row actually holds now - alerts gate on THIS, not the
      // engine's transient opinion.
      const effectiveStatus = match.status;

      // Surface the EFFECTIVE persisted status back to the caller, overwriting
      // the engine's transient opinion on the returned result. The UI keys its
      // heading AND its "now tracking / not tracked" message off result.status,
      // so without this a merchant-locked row renders a contradiction: a
      // re-checked REJECTED competitor whose matcher now says "auto" would show
      // "Match (auto-tracked) - now tracking", and a CONFIRMED row the matcher
      // now rejects would show "Not the same product" while still tracked. The
      // row's persisted status is the merchant-facing truth; show that.
      result.status = effectiveStatus;

      // Mark when the displayed status is a STICKY MERCHANT decision (confirmed
      // / rejected) rather than the engine's fresh call. result.confidence and
      // result.reasons still carry the engine's live numbers, so a locked row
      // would otherwise read as a contradiction -- a big confidence % sitting
      // above "Not the same product" (or a tiny % under "Confirmed match") with
      // nothing explaining the gap. The UI uses this flag to render that
      // explanation and point at the reconsider affordance. True whenever the
      // persisted status is merchant-locked, regardless of whether the engine
      // now agrees, because the merchant did make that call either way.
      result.merchantLocked =
        existing != null && MERCHANT_LOCKED.has(existing.status);

      // Record a reading for any tracked (non-rejected) source -- including a
      // null price, which is the signal silent-failure detection looks for.
      if (effectiveStatus !== "rejected") {
        // Grab the prior reading BEFORE writing the new one, so we can detect a
        // transition (price drop / back in stock) to alert on.
        const prior = await prisma.observation.findFirst({
          where: { matchId: match.id },
          orderBy: { scrapedAt: "desc" },
        });

        const newPrice = result.price != null ? Number(result.price) : null;
        const newCurrency = result.currency ?? null;
        const newInStock =
          typeof result.in_stock === "boolean" ? result.in_stock : null;

        await prisma.observation.create({
          data: {
            matchId: match.id,
            price: newPrice,
            currency: newCurrency,
            inStock: newInStock,
            via: result.extracted_via ?? null,
          },
        });

        // 3) Emit alerts on a triggering transition. The decision is pure
        //    (see alerts.ts / test_alerts.ts); here we just persist the drafts.
        //    Failure must not lose the reading, so it is isolated.
        try {
          const drafts = decideAlerts({
            prior: prior ? { price: prior.price, inStock: prior.inStock } : null,
            next: { price: newPrice, inStock: newInStock, currency: newCurrency },
            effectiveStatus,
            productTitle,
            competitorHost,
          });
          for (const d of drafts) {
            await prisma.alert.create({
              data: {
                shop,
                matchId: match.id,
                type: d.type,
                message: d.message,
                oldValue: d.oldValue,
                newValue: d.newValue,
                currency: d.currency,
              },
            });
          }
        } catch (alertErr) {
          console.error("Alert emit failed:", alertErr);
        }
      }
      saved = true;
    }
  } catch (e) {
    console.error("Persist failed:", e);
    saved = false;
  }

  return { result, error: null, saved };
}

export type DiscoverResult = {
  candidates: string[];
  queries: string[];
  error: string | null;
};

// Domains that are never a competitor storefront -- social, video, forums,
// encyclopedias, blogs. Discovery search can surface these; we drop them so the
// merchant only sees real product pages. Matched on the host (and any
// subdomain), case-insensitive.
const NON_STORE_HOSTS = new Set([
  "youtube.com", "youtu.be", "reddit.com", "facebook.com", "instagram.com",
  "twitter.com", "x.com", "tiktok.com", "pinterest.com", "quora.com",
  "linkedin.com", "wikipedia.org", "medium.com", "tumblr.com",
  "blogspot.com", "wordpress.com",
]);

function isStoreCandidate(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).host.toLowerCase().replace(/^www\./, "");
  } catch {
    return false;
  }
  for (const bad of NON_STORE_HOSTS) {
    if (host === bad || host.endsWith("." + bad)) return false;
  }
  return true;
}

// Ask the engine for candidate competitor URLs for a merchant product. URLs
// ONLY -- no fetch, no match, no DB write here. The caller renders these and
// lets the merchant run each through the existing manual "Check" path
// (recheckMatch), so discovery never introduces a second match/persist route:
// discovery generates candidates, the proven matcher decides. Mirrors
// recheckMatch's engine-call error handling (same ENGINE_URL, same "is
// serve.py running?" message) so a dead service fails the same friendly way.
// A missing search-API key comes back from the engine as a non-null `error`
// with an empty candidate list (HTTP 200), so the UI can show a setup prompt
// rather than treat it as a crash.
//
// Candidates are filtered to real storefronts (isStoreCandidate) so obvious
// non-shops -- YouTube, Reddit, social, wikis -- never reach the merchant.
export async function discoverCompetitors(params: {
  merchant: Record<string, unknown>;
}): Promise<DiscoverResult> {
  const { merchant } = params;
  try {
    const res = await fetch(`${ENGINE_URL}/discover`, {
      method: "POST",
      headers: engineHeaders(),
      body: JSON.stringify({ merchant }),
    });
    const data = (await res.json()) as any;
    return {
      candidates: (Array.isArray(data.candidates) ? data.candidates : []).filter(
        (u: any) => typeof u === "string" && isStoreCandidate(u),
      ),
      queries: Array.isArray(data.queries) ? data.queries : [],
      error: data.error ?? null,
    };
  } catch (e: any) {
    return {
      candidates: [],
      queries: [],
      error: `Could not reach the engine service at ${ENGINE_URL}. Is "python serve.py" running? (${e?.message ?? e})`,
    };
  }
}
