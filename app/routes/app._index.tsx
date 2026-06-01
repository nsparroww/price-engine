import { useState } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";

// The local Python engine service (serve.py). Server-side call only.
const ENGINE_URL = "http://127.0.0.1:8787";

type CatalogProduct = {
  id: string;
  title: string;
  brand: string | null;
  price: string | null;
  gtin: string | null;
  sku: string | null;
};

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
  // for audit but aren't shown here). Pull the two newest readings per match so
  // we can show the price movement since last check, plus a total count.
  const trackedRaw = await prisma.match.findMany({
    where: { shop, status: { not: "rejected" } },
    orderBy: { updatedAt: "desc" },
    include: {
      observations: { orderBy: { scrapedAt: "desc" }, take: 2 },
      _count: { select: { observations: true } },
    },
  });

  const tracked = trackedRaw.map((m) => {
    const latest = m.observations[0] ?? null;
    const previous = m.observations[1] ?? null;

    // Price delta vs the immediately previous reading (rounded to cents to
    // avoid float noise). Null when either side lacks a price.
    let priceDelta: number | null = null;
    if (latest?.price != null && previous?.price != null) {
      priceDelta = Math.round((latest.price - previous.price) * 100) / 100;
    }
    // The silent-failure signal: we used to read a price here, now we don't.
    const priceDisappeared =
      latest != null && latest.price == null && previous?.price != null;

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
    };
  });

  return { currency: data?.shop?.currencyCode ?? "", products, tracked };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const form = await request.formData();
  const competitorUrl = String(form.get("competitorUrl") || "").trim();
  let merchant: Record<string, unknown> = {};
  try {
    merchant = JSON.parse(String(form.get("product") || "{}"));
  } catch {
    merchant = {};
  }

  if (!competitorUrl) {
    return { result: null, error: "Enter a competitor product URL.", saved: false };
  }

  // 1) Ask the engine for a match decision.
  let result: any = null;
  try {
    const res = await fetch(`${ENGINE_URL}/match`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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
    let competitorHost: string | null = null;
    try {
      competitorHost = new URL(competitorUrl).host;
    } catch {
      competitorHost = null;
    }

    if (productGid) {
      const match = await prisma.match.upsert({
        where: {
          shop_productGid_competitorUrl: { shop, productGid, competitorUrl },
        },
        update: {
          productTitle,
          competitorHost,
          confidence: Number(result.confidence ?? 0),
          method: String(result.method ?? ""),
          status: String(result.status ?? "auto"),
        },
        create: {
          shop,
          productGid,
          productTitle,
          competitorUrl,
          competitorHost,
          confidence: Number(result.confidence ?? 0),
          method: String(result.method ?? ""),
          status: String(result.status ?? "auto"),
        },
      });

      // Record a reading for any tracked (non-rejected) source — including a
      // null price, which is the signal silent-failure detection looks for.
      if (result.status !== "rejected") {
        await prisma.observation.create({
          data: {
            matchId: match.id,
            price: result.price != null ? Number(result.price) : null,
            currency: result.currency ?? null,
            inStock: typeof result.in_stock === "boolean" ? result.in_stock : null,
            via: result.extracted_via ?? null,
          },
        });
      }
      saved = true;
    }
  } catch (e) {
    console.error("Persist failed:", e);
    saved = false;
  }

  return { result, error: null, saved };
};

const STATUS_LABEL: Record<string, string> = {
  auto: "Match (auto-tracked)",
  needs_review: "Possible match - needs review",
  confirmed: "Confirmed match",
  rejected: "Not the same product",
};

export default function Index() {
  const { currency, products, tracked } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const [selected, setSelected] = useState(0);
  const [url, setUrl] = useState("");

  const busy = fetcher.state !== "idle";
  const data = fetcher.data;
  const r = data?.result;

  // Submit helper — builds explicit FormData so the fields can never be dropped
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

  const recheck = (t: (typeof tracked)[number]) => {
    const product = products.find((p) => p.id === t.productGid);
    if (!product) return;
    runCheck(JSON.stringify(product), t.competitorUrl);
  };

  return (
    <s-page heading="Price Engine">
      <s-section heading="Check a competitor">
        <s-paragraph>
          Pick one of your products, paste a competitor&apos;s product-page URL,
          and Price Engine will read its price and decide whether it&apos;s the
          same product.
        </s-paragraph>

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

          <label>
            <s-text>Competitor product URL</s-text>
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

        {data?.error && (
          <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
            <s-text>! {data.error}</s-text>
          </s-box>
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
              {data?.saved && r.status !== "rejected" && (
                <s-text>Saved - now tracking this competitor&apos;s price.</s-text>
              )}
              {data?.saved && r.status === "rejected" && (
                <s-text>Saved this decision (not tracked).</s-text>
              )}
            </s-stack>
          </s-section>
        )}
      </s-section>

      <s-section heading={`Tracked competitors (${tracked.length})`}>
        {tracked.length === 0 ? (
          <s-paragraph>
            No saved competitors yet. Check one above to start tracking it.
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

                    {/* Price movement since the previous reading */}
                    {t.observationCount < 2 ? (
                      <s-text>First reading - no comparison yet.</s-text>
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
                      {t.lastScrapedAt
                        ? ` - last checked ${new Date(t.lastScrapedAt).toLocaleString()}`
                        : ""}
                    </s-text>
                    {inCatalog ? (
                      <s-stack direction="inline" gap="base">
                        <s-button
                          onClick={() => recheck(t)}
                          {...(busy ? { loading: true } : {})}
                        >
                          Re-check now
                        </s-button>
                      </s-stack>
                    ) : (
                      <s-text>Product not in current catalog - can&apos;t re-check.</s-text>
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
