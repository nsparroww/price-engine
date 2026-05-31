import { useState } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";

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
  const { admin } = await authenticate.admin(request);

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

  return { currency: data?.shop?.currencyCode ?? "", products };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  await authenticate.admin(request); // ensure the request is authenticated

  const form = await request.formData();
  const competitorUrl = String(form.get("competitorUrl") || "").trim();
  let merchant: Record<string, unknown> = {};
  try {
    merchant = JSON.parse(String(form.get("product") || "{}"));
  } catch {
    merchant = {};
  }

  if (!competitorUrl) {
    return { result: null, error: "Enter a competitor product URL." };
  }

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
    if (data.error) return { result: null, error: data.error };
    return { result: data.results?.[0] ?? null, error: null };
  } catch (e: any) {
    return {
      result: null,
      error: `Could not reach the engine service at ${ENGINE_URL}. Is "python serve.py" running? (${e?.message ?? e})`,
    };
  }
};

const STATUS_LABEL: Record<string, string> = {
  auto: "Match (auto-tracked)",
  needs_review: "Possible match - needs review",
  confirmed: "Confirmed match",
  rejected: "Not the same product",
};

export default function Index() {
  const { currency, products } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const [selected, setSelected] = useState(0);
  const [url, setUrl] = useState("");

  const busy = fetcher.state !== "idle";
  const data = fetcher.data;
  const r = data?.result;

  const check = () => {
    const product = products[selected];
    if (!product) return;
    fetcher.submit(
      { product: JSON.stringify(product), competitorUrl: url },
      { method: "POST" },
    );
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
            </s-stack>
          </s-section>
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
