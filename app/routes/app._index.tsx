import { useState, useEffect, useRef } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";
import { recheckMatch, discoverCompetitors } from "../lib/recheck.server";
import { getPlanInfo, UNLIMITED } from "../lib/billing.server";

// App handle for building the managed-pricing plan-selection URL. This is the
// handle Shopify assigns the app -- read it from the admin URL while the app is
// open: admin.shopify.com/store/<store>/apps/<THIS>. It is NOT the dashboard
// display slug; Shopify appends a disambiguating suffix (here, "-5"). The plan
// page lives at
//   https://admin.shopify.com/store/<storeHandle>/charges/<APP_HANDLE>/pricing_plans
// A wrong handle 404s on the upgrade click.
const APP_HANDLE = "price-engine-5";

type CatalogProduct = {
  id: string;
  title: string;
  brand: string | null;
  price: string | null;
  gtin: string | null;
  sku: string | null;
};

// Render an ISO timestamp client-side only. `new Date(iso).toLocaleString()`
// formats in the SERVER's timezone/locale during SSR and the BROWSER's on the
// client, so rendering it directly yields different text on each side and
// breaks hydration (React #425 "text content does not match", which cascades
// into #418/#423 and leaves the tree half-hydrated -- which in turn stops
// effects like the review-ask from running). We render a fixed placeholder on
// the server and during the first client render (both produce the same text,
// so hydration matches), then swap in the localized string after mount. The
// merchant sees THEIR local time, and there is no nondeterminism to mismatch.
function ClientDate({ iso }: { iso: string }) {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    setText(new Date(iso).toLocaleString());
  }, [iso]);
  return <>{text ?? "..."}</>;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;

  const response = await admin.graphql(
    `#graphql
      query CatalogForMatching {
        shop { currencyCode }
        products(first: 50, sortKey: TITLE) {
          edges {
            node {
              id
              title
              vendor
              variants(first: 1) {
                edges { node { price barcode sku } }
              }
            }
          }
        }
      }`,
  );

  const json = (await response.json()) as any;
  const data = json?.data;

  const products: CatalogProduct[] = (data?.products?.edges ?? []).map(
    (edge: any) => {
      const node = edge?.node ?? {};
      const variant = node?.variants?.edges?.[0]?.node ?? {};
      return {
        id: node.id ?? "",
        title: node.title ?? "(untitled)",
        brand: node.vendor || null,
        price: variant.price ?? null,
        gtin: variant.barcode || null,
        sku: variant.sku || null,
      };
    },
  );

  // Saved matches we're actually tracking (rejected decisions stay in the DB
  // for audit but aren't shown here). Pull a short window of recent readings
  // per match: enough to show price movement AND to spot a broken-scraper
  // streak (consecutive no-price reads), plus a total count.
  const trackedRaw = await prisma.match.findMany({
    where: { shop, status: { not: "rejected" } },
    orderBy: { updatedAt: "desc" },
    include: {
      observations: { orderBy: { scrapedAt: "desc" }, take: 6 },
      _count: { select: { observations: true } },
    },
  });

  const tracked = trackedRaw.map((m) => {
    const obs = m.observations; // newest first
    const latest = obs[0] ?? null;
    const previous = obs[1] ?? null;

    // Price delta vs the immediately previous reading (rounded to cents to
    // avoid float noise). Null when either side lacks a price.
    let priceDelta: number | null = null;
    if (latest?.price != null && previous?.price != null) {
      priceDelta = Math.round((latest.price - previous.price) * 100) / 100;
    }
    // The silent-failure signal: we used to read a price here, now we don't.
    const priceDisappeared =
      latest != null && latest.price == null && previous?.price != null;

    // Broken-scraper signal: how many of the most-recent reads in a row had no
    // price. 1 is a blip; >=2 is a sustained failure worth acting on. Counted
    // only across the pulled window, so it floors at that window size.
    let consecutiveNulls = 0;
    for (const o of obs) {
      if (o.price == null) consecutiveNulls++;
      else break;
    }
    // Most recent reading that DID have a price, for the "last known" message.
    const lastKnown = obs.find((o) => o.price != null) ?? null;

    return {
      id: m.id,
      productGid: m.productGid,
      productTitle: m.productTitle,
      competitorUrl: m.competitorUrl,
      competitorHost: m.competitorHost,
      status: m.status,
      confidence: m.confidence,
      lastPrice: latest?.price ?? null,
      lastCurrency: latest?.currency ?? null,
      lastInStock: latest?.inStock ?? null,
      lastScrapedAt: latest ? latest.scrapedAt.toISOString() : null,
      observationCount: m._count.observations,
      prevPrice: previous?.price ?? null,
      priceDelta,
      priceDisappeared,
      consecutiveNulls,
      lastKnownPrice: lastKnown?.price ?? null,
      lastKnownCurrency: lastKnown?.currency ?? null,
    };
  });

  // Recent alerts (newest first). Dismissed ones are kept (readAt set) and
  // shown greyed, for audit and so a later email job still sees history.
  const alertRows = await prisma.alert.findMany({
    where: { shop },
    orderBy: { createdAt: "desc" },
    take: 20,
  });
  const alerts = alertRows.map((al) => ({
    id: al.id,
    type: al.type,
    message: al.message,
    createdAt: al.createdAt.toISOString(),
    read: al.readAt != null,
  }));
  const unreadCount = alerts.filter((a) => !a.read).length;

  // Plan + cap. Soft-gate model: we do NOT force-redirect a merchant without a
  // plan (the activation moment must precede the paywall). We only read the cap
  // here to show "X / Y tracked" and to feed the action's tracking gate. The
  // tracked count is what the gate counts (status != rejected), identical to
  // the `tracked` query above, so the displayed number and the enforced number
  // can't disagree.
  const plan = await getPlanInfo(admin);
  const storeHandle = shop.replace(".myshopify.com", "");
  const upgradeUrl = `https://admin.shopify.com/store/${storeHandle}/charges/${APP_HANDLE}/pricing_plans`;

  // Review-ask gate. The flywheel's compounding mechanic: ask for an App Store
  // review at the first proven value moment -- an auto/confirmed competitor that
  // has actually produced a price (the moat visibly delivered). Derived from
  // `tracked` (already loaded) so it costs no extra query until that moment
  // exists. needs_review is excluded on purpose: we only ask after a confident
  // or merchant-confirmed match. The ShopState guard makes the ask fire at most
  // once per merchant, ever -- and we only touch that table once there's
  // something worth asking about.
  const hasValueMoment = tracked.some(
    (t) =>
      (t.status === "auto" || t.status === "confirmed") &&
      t.lastKnownPrice != null,
  );
  let reviewAsk = false;
  if (hasValueMoment) {
    const shopState = await prisma.shopState.findUnique({ where: { shop } });
    reviewAsk = shopState?.reviewAskedAt == null;
  }

  return {
    currency: data?.shop?.currencyCode ?? "",
    products,
    tracked,
    alerts,
    unreadCount,
    planName: plan.planName,
    cap: plan.cap,
    isUnlimited: plan.isUnlimited,
    trackedCount: tracked.length,
    upgradeUrl,
    reviewAsk,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;

  const form = await request.formData();
  const intent = String(form.get("intent") || "match");

  // --- Status update (confirm / reject) -- patches the Match, no re-scrape.
  if (intent === "setStatus") {
    const matchId = String(form.get("matchId") || "");
    const status = String(form.get("status") || "");
    const allowed = ["confirmed", "rejected", "needs_review", "auto"];
    if (matchId && allowed.includes(status)) {
      // updateMany + shop scope: can't touch another shop's row, won't throw
      // on a stale id.
      await prisma.match.updateMany({
        where: { id: matchId, shop },
        data: { status },
      });
    }
    return { result: null, error: null, saved: false };
  }

  // --- Dismiss an alert (set readAt). Row kept for audit / history.
  if (intent === "dismissAlert") {
    const alertId = String(form.get("alertId") || "");
    if (alertId) {
      await prisma.alert.updateMany({
        where: { id: alertId, shop },
        data: { readAt: new Date() },
      });
    }
    return { result: null, error: null, saved: false };
  }

  // --- Record that we've requested the in-app review modal, so it fires at
  //     most once per merchant. The client calls this ONLY after App Bridge
  //     reported the modal was actually shown (success === true). A
  //     rate-limited / ineligible miss does NOT mark, so a later value-moment
  //     load can retry until Shopify lets the modal through.
  if (intent === "markReviewAsked") {
    await prisma.shopState.upsert({
      where: { shop },
      update: { reviewAskedAt: new Date() },
      create: { shop, reviewAskedAt: new Date() },
    });
    return { result: null, error: null, saved: false };
  }

  // --- Discover: ask the engine for candidate competitor URLs for the selected
  //     product. URLs ONLY -- no fetch, no match, no DB write here. The merchant
  //     then clicks "Check" on the ones they want, routing each through the same
  //     match+persist path manual paste uses (no second decision route). This is
  //     the differentiator: the merchant never types a competitor URL.
  if (intent === "discover") {
    let merchant: Record<string, unknown> = {};
    try {
      merchant = JSON.parse(String(form.get("product") || "{}"));
    } catch {
      merchant = {};
    }
    const { candidates, queries, error } = await discoverCompetitors({ merchant });
    return { discover: { candidates, queries, error } };
  }

  // --- Default: match a competitor URL against a merchant product.
  //     The engine call + persist is the shared recheckMatch path so the
  //     scheduler runs the exact same code (no drift). We resolve the plan cap
  //     here (UI path has a session) and pass it so a NEW competitor over the
  //     limit is blocked before persist; the scheduler omits it (no gate).
  const competitorUrl = String(form.get("competitorUrl") || "").trim();
  let merchant: Record<string, unknown> = {};
  try {
    merchant = JSON.parse(String(form.get("product") || "{}"));
  } catch {
    merchant = {};
  }

  const plan = await getPlanInfo(admin);
  return await recheckMatch({ shop, merchant, competitorUrl, cap: plan.cap });
};

const STATUS_LABEL: Record<string, string> = {
  auto: "Match (auto-tracked)",
  needs_review: "Possible match - needs review",
  confirmed: "Confirmed match",
  rejected: "Not the same product",
};

const ALERT_LABEL: Record<string, string> = {
  price_drop: "Price drop",
  back_in_stock: "Back in stock",
};

// Inline style for the upgrade/plan links. We use a raw <a target="_top">
// rather than <s-button href> because (a) breaking OUT of the embedded iframe
// to an admin URL needs a real top-level navigation, which a user-clicked
// anchor does reliably across browsers (Safari blocks programmatic
// window.open from the iframe), and (b) Polaris s-button/s-link href has known
// redirect bugs inside React Router apps. Styled to read as a primary button.
const UPGRADE_LINK_STYLE: React.CSSProperties = {
  display: "inline-block",
  padding: "8px 16px",
  background: "#008060",
  color: "white",
  borderRadius: "8px",
  textDecoration: "none",
  fontWeight: 600,
};

export default function Index() {
  const {
    currency,
    products,
    tracked,
    alerts,
    unreadCount,
    cap,
    isUnlimited,
    trackedCount,
    upgradeUrl,
    reviewAsk,
  } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const [selected, setSelected] = useState(0);
  const [url, setUrl] = useState("");

  // Dedicated fetcher for the review-ask mark, kept separate from `fetcher` so
  // it never collides with the merchant's own actions (no spurious busy state).
  const reviewFetcher = useFetcher();
  const reviewAskedRef = useRef(false);

  const busy = fetcher.state !== "idle";
  const data = fetcher.data as any;
  const r = data?.result;
  const discover = data?.discover;
  const atLimit = data?.atLimit === true;

  // Human-readable cap for display. UNLIMITED renders as the word, never a
  // number, matching the billing.server sentinel.
  const capLabel = isUnlimited ? "unlimited" : String(cap);

  // Fire the App Store review modal at the first value moment, once. This runs
  // on the loader-driven `reviewAsk` transition (e.g. the revalidation right
  // after a competitor auto-tracks), NOT in a button handler -- Shopify warns
  // that triggering on a click can collide with rate-limiting and make the app
  // look broken. App Bridge (window.shopify, the v4 CDN global) only shows the
  // modal if its own eligibility/rate-limit checks pass; we mark "asked" only
  // when it actually showed (success === true), so a throttled miss retries on
  // a later value load instead of burning the one ask. The ref guards against
  // re-entry within a single mount (StrictMode double-invoke, later
  // revalidations); a fresh navigation remounts and may retry if still unmarked.
  useEffect(() => {
    if (!reviewAsk || reviewAskedRef.current) return;
    reviewAskedRef.current = true;
    (async () => {
      let shown = false;
      try {
        const result = await (window as any).shopify?.reviews?.request();
        shown = result?.success === true;
      } catch {
        shown = false;
      }
      if (shown) {
        const fd = new FormData();
        fd.set("intent", "markReviewAsked");
        reviewFetcher.submit(fd, { method: "POST" });
      }
    })();
    // reviewFetcher is stable; ref guards re-entry within a mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reviewAsk]);

  // Submit helper -- builds explicit FormData so the fields can never be dropped
  // by object-shorthand serialization. Refuses to submit an empty URL.
  const runCheck = (productJson: string, competitorUrl: string) => {
    if (!competitorUrl.trim()) return;
    const fd = new FormData();
    fd.set("product", productJson);
    fd.set("competitorUrl", competitorUrl);
    fetcher.submit(fd, { method: "POST" });
  };

  const check = () => {
    const product = products[selected];
    if (!product) return;
    runCheck(JSON.stringify(product), url);
  };

  // Find competitors for the selected product (discovery). Returns URLs the
  // merchant then checks individually -- no URL typing required.
  const findCompetitors = () => {
    const product = products[selected];
    if (!product) return;
    const fd = new FormData();
    fd.set("intent", "discover");
    fd.set("product", JSON.stringify(product));
    fetcher.submit(fd, { method: "POST" });
  };

  // Check a discovered candidate against the currently selected product, reusing
  // the proven manual-check path.
  const checkCandidate = (candidateUrl: string) => {
    const product = products[selected];
    if (!product) return;
    runCheck(JSON.stringify(product), candidateUrl);
  };

  const recheck = (t: (typeof tracked)[number]) => {
    const product = products.find((p) => p.id === t.productGid);
    if (!product) return;
    runCheck(JSON.stringify(product), t.competitorUrl);
  };

  const setStatus = (matchId: string, status: string) => {
    const fd = new FormData();
    fd.set("intent", "setStatus");
    fd.set("matchId", matchId);
    fd.set("status", status);
    fetcher.submit(fd, { method: "POST" });
  };

  const dismissAlert = (alertId: string) => {
    const fd = new FormData();
    fd.set("intent", "dismissAlert");
    fd.set("alertId", alertId);
    fetcher.submit(fd, { method: "POST" });
  };

  return (
    <s-page heading="Price Engine">
      <s-section heading="Find competitors">
        <s-paragraph>
          Pick one of your products and let Price Engine find competitors selling
          it -- no URL hunting. Review the candidates it finds and track the ones
          that matter with one tap. (Or paste a specific competitor URL below.)
        </s-paragraph>

        <s-paragraph>
          Tracking {trackedCount} of {capLabel} competitor
          {capLabel === "1" ? "" : "s"} on your current plan.
        </s-paragraph>

        {/* Persistent path to the managed-pricing plan page. Always visible so
            both merchants and the App Store reviewer can reach billing without
            first hitting the cap. target="_top" breaks out of the embedded
            iframe to the Shopify-hosted plan selector. */}
        <s-stack direction="inline" gap="base">
          <a href={upgradeUrl} target="_top" style={UPGRADE_LINK_STYLE}>
            {isUnlimited ? "Manage plan" : "View plans"}
          </a>
        </s-stack>

        <s-stack direction="block" gap="base">
          <label>
            <s-text>Your product</s-text>
            <select
              value={selected}
              onChange={(e) => setSelected(Number(e.target.value))}
              style={{ display: "block", width: "100%", padding: "8px", marginTop: 4 }}
            >
              {products.map((p, i) => (
                <option key={p.id} value={i}>
                  {p.title}
                </option>
              ))}
            </select>
          </label>

          <s-stack direction="inline" gap="base">
            <s-button
              onClick={findCompetitors}
              {...(busy ? { loading: true } : {})}
            >
              Find competitors
            </s-button>
          </s-stack>

          <label>
            <s-text>Or paste a competitor product URL</s-text>
            <input
              type="url"
              value={url}
              placeholder="https://competitor.com/products/..."
              onChange={(e) => setUrl(e.target.value)}
              style={{ display: "block", width: "100%", padding: "8px", marginTop: 4 }}
            />
          </label>

          <s-stack direction="inline" gap="base">
            <s-button
              onClick={check}
              {...(busy ? { loading: true } : {})}
            >
              Check competitor
            </s-button>
          </s-stack>
        </s-stack>

        {/* Plan-limit prompt. Shown when the action blocked a NEW competitor
            because the shop is at its cap. The match still ran (the merchant
            sees it worked just below); only tracking is gated. The upgrade
            link sends them to the managed-pricing plan page. */}
        {atLimit && (
          <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
            <s-stack direction="block" gap="base">
              <s-text>
                You're tracking {data?.tracked ?? trackedCount} of {capLabel} competitors -
                your plan's limit. This match wasn't tracked. Upgrade to track
                more competitors.
              </s-text>
              <s-stack direction="inline" gap="base">
                <a href={upgradeUrl} target="_top" style={UPGRADE_LINK_STYLE}>
                  Upgrade plan
                </a>
              </s-stack>
            </s-stack>
          </s-box>
        )}

        {data?.error && (
          <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
            <s-text>! {data.error}</s-text>
          </s-box>
        )}

        {/* Discovery results: candidate URLs the merchant can check one-tap.
            Each routes through the same match path as manual paste. */}
        {discover && (
          <s-section
            heading={
              discover.candidates.length > 0
                ? `Found ${discover.candidates.length} possible competitor page(s)`
                : "No competitors found"
            }
          >
            {discover.error ? (
              <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
                <s-text>
                  Discovery unavailable: {discover.error}
                </s-text>
              </s-box>
            ) : discover.candidates.length === 0 ? (
              <s-paragraph>
                No candidate pages came back for this product. Try a different
                product, or paste a competitor URL directly above.
              </s-paragraph>
            ) : (
              <s-stack direction="block" gap="base">
                <s-text>
                  Click Check on any that look like a real competitor selling
                  this product. Price Engine reads each page and decides if
                  it&apos;s the same item.
                </s-text>
                {discover.candidates.map((cu: string) => (
                  <s-box key={cu} padding="base" borderWidth="base" borderRadius="base">
                    <s-stack direction="block" gap="base">
                      <s-text>{cu}</s-text>
                      <s-stack direction="inline" gap="base">
                        <s-button
                          onClick={() => checkCandidate(cu)}
                          {...(busy ? { loading: true } : {})}
                        >
                          Check
                        </s-button>
                      </s-stack>
                    </s-stack>
                  </s-box>
                ))}
              </s-stack>
            )}
          </s-section>
        )}

        {r && (
          <s-section heading={STATUS_LABEL[r.status] ?? r.status}>
            <s-stack direction="block" gap="base">
              <s-text>Competitor title: {r.title ?? "-"}</s-text>
              <s-text>
                Price: {r.price != null ? `${r.currency ?? ""} ${r.price}` : "- (no price found)"}
              </s-text>
              <s-text>
                Availability:{" "}
                {r.in_stock === true ? "in stock" : r.in_stock === false ? "out of stock" : "unknown"}
              </s-text>
              <s-text>
                Confidence: {Math.round((r.confidence ?? 0) * 100)}% - via {r.extracted_via} - {r.method}
              </s-text>
              {Array.isArray(r.reasons) && r.reasons.length > 0 && (
                <s-text>Why: {r.reasons.join("; ")}</s-text>
              )}
              {atLimit && (
                <s-text>
                  Not tracked - you're at your plan's competitor limit (see above).
                </s-text>
              )}
              {data?.saved && r.status !== "rejected" && r.status !== "needs_review" && (
                <s-text>Saved - now tracking this competitor&apos;s price.</s-text>
              )}
              {data?.saved && r.status === "needs_review" && (
                <s-text>Saved - pending your confirmation.</s-text>
              )}
              {data?.saved && r.status === "rejected" && (
                <s-text>Saved this decision (not tracked).</s-text>
              )}
            </s-stack>
          </s-section>
        )}
      </s-section>

      <s-section heading={unreadCount > 0 ? `Alerts (${unreadCount} unread)` : "Alerts"}>
        {alerts.length === 0 ? (
          <s-paragraph>
            No alerts yet. Confirmed competitors that drop in price or come back
            in stock will show up here.
          </s-paragraph>
        ) : (
          <s-stack direction="block" gap="base">
            {alerts.map((a) => (
              <s-box
                key={a.id}
                padding="base"
                borderWidth="base"
                borderRadius="base"
                {...(a.read ? { background: "subdued" } : {})}
              >
                <s-stack direction="block" gap="base">
                  <s-text>
                    {a.read ? "" : "* "}
                    {a.message}
                  </s-text>
                  <s-text>
                    {ALERT_LABEL[a.type] ?? a.type} -{" "}
                    <ClientDate iso={a.createdAt} />
                    {a.read ? " - dismissed" : ""}
                  </s-text>
                  {!a.read && (
                    <s-stack direction="inline" gap="base">
                      <s-button
                        onClick={() => dismissAlert(a.id)}
                        {...(busy ? { loading: true } : {})}
                      >
                        Dismiss
                      </s-button>
                    </s-stack>
                  )}
                </s-stack>
              </s-box>
            ))}
          </s-stack>
        )}
      </s-section>

      <s-section heading={`Tracked competitors (${tracked.length})`}>
        {tracked.length === 0 ? (
          <s-paragraph>
            No saved competitors yet. Find or check one above to start tracking it.
          </s-paragraph>
        ) : (
          <s-stack direction="block" gap="base">
            {tracked.map((t) => {
              const inCatalog = products.some((p) => p.id === t.productGid);
              return (
                <s-box key={t.id} padding="base" borderWidth="base" borderRadius="base">
                  <s-stack direction="block" gap="base">
                    <s-heading>{t.productTitle}</s-heading>
                    <s-text>
                      {STATUS_LABEL[t.status] ?? t.status} -{" "}
                      {Math.round((t.confidence ?? 0) * 100)}% confidence
                    </s-text>
                    <s-text>Competitor: {t.competitorHost ?? t.competitorUrl}</s-text>
                    <s-text>
                      Last reading:{" "}
                      {t.lastPrice != null
                        ? `${t.lastCurrency ?? ""} ${t.lastPrice}`
                        : "no price"}
                      {t.lastInStock === true
                        ? " - in stock"
                        : t.lastInStock === false
                          ? " - out of stock"
                          : ""}
                    </s-text>

                    {/* Price movement / source health since the previous reading.
                        A sustained no-price streak (>=2) takes priority over the
                        single-check "disappeared" blip. */}
                    {t.observationCount < 2 ? (
                      <s-text>First reading - no comparison yet.</s-text>
                    ) : t.consecutiveNulls >= 2 ? (
                      <s-text>
                        Source may be broken: the last {t.consecutiveNulls}{" "}
                        checks found no price
                        {t.lastKnownPrice != null
                          ? ` (last known price ${t.lastKnownCurrency ?? ""} ${t.lastKnownPrice})`
                          : ""}
                        . The page layout or scraper likely changed.
                      </s-text>
                    ) : t.priceDisappeared ? (
                      <s-text>
                        Warning: no price found this check (last was{" "}
                        {t.lastCurrency ?? ""} {t.prevPrice}) - the page or
                        scraper may have changed.
                      </s-text>
                    ) : t.priceDelta == null ? (
                      <s-text>Price comparison unavailable.</s-text>
                    ) : t.priceDelta === 0 ? (
                      <s-text>Price unchanged since last check.</s-text>
                    ) : t.priceDelta > 0 ? (
                      <s-text>
                        Price up {t.lastCurrency ?? ""} {Math.abs(t.priceDelta)}{" "}
                        since last check.
                      </s-text>
                    ) : (
                      <s-text>
                        Price down {t.lastCurrency ?? ""} {Math.abs(t.priceDelta)}{" "}
                        since last check.
                      </s-text>
                    )}

                    <s-text>
                      {t.observationCount} reading{t.observationCount === 1 ? "" : "s"}
                      {t.lastScrapedAt ? (
                        <>
                          {" - last checked "}
                          <ClientDate iso={t.lastScrapedAt} />
                        </>
                      ) : (
                        ""
                      )}
                    </s-text>

                    <s-stack direction="inline" gap="base">
                      {inCatalog && (
                        <s-button
                          onClick={() => recheck(t)}
                          {...(busy ? { loading: true } : {})}
                        >
                          Re-check now
                        </s-button>
                      )}
                      {t.status === "needs_review" && (
                        <s-button
                          onClick={() => setStatus(t.id, "confirmed")}
                          {...(busy ? { loading: true } : {})}
                        >
                          Confirm match
                        </s-button>
                      )}
                      <s-button
                        onClick={() => setStatus(t.id, "rejected")}
                        {...(busy ? { loading: true } : {})}
                      >
                        Not a match
                      </s-button>
                    </s-stack>

                    {!inCatalog && (
                      <s-text>
                        Product not in current catalog - can&apos;t re-check.
                      </s-text>
                    )}
                  </s-stack>
                </s-box>
              );
            })}
          </s-stack>
        )}
      </s-section>

      <s-section heading={`Your catalog (${products.length})`}>
        {products.length === 0 ? (
          <s-paragraph>No products found in this store yet.</s-paragraph>
        ) : (
          <s-stack direction="block" gap="base">
            {products.map((p) => (
              <s-box key={p.id} padding="base" borderWidth="base" borderRadius="base">
                <s-stack direction="block" gap="base">
                  <s-heading>{p.title}</s-heading>
                  <s-text>
                    Brand: {p.brand ?? "-"} - Price:{" "}
                    {p.price ? `${currency} ${p.price}` : "-"}
                  </s-text>
                  <s-text>GTIN: {p.gtin ?? "-"} - SKU: {p.sku ?? "-"}</s-text>
                </s-stack>
              </s-box>
            ))}
          </s-stack>
        )}
      </s-section>

      <s-section slot="aside" heading="How matching works">
        <s-paragraph>
          The engine reads the competitor page (JSON-LD first), then matches on
          GTIN / part number first and title + brand as a fallback. High
          confidence auto-tracks; medium asks you to confirm; a conflicting
          identifier is rejected outright.
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
