// Pure alert-decision logic: given the prior reading, the new reading, and the
// match's effective (merchant-aware) status, return the alerts to emit. No DB,
// no engine, no I/O - so it is deterministically testable (see test_alerts.ts).
// recheckMatch maps these drafts to Alert rows (adding shop + matchId).

export type AlertDraft = {
  type: "price_drop" | "back_in_stock";
  message: string;
  oldValue: string | null;
  newValue: string | null;
  currency: string | null;
};

export type Reading = {
  price: number | null;
  inStock: boolean | null;
};

// Statuses on which alerts may fire. needs_review / rejected stay silent.
const ALERTABLE = new Set(["auto", "confirmed"]);

export function decideAlerts(args: {
  prior: Reading | null;
  next: Reading & { currency: string | null };
  effectiveStatus: string;
  productTitle: string;
  competitorHost: string | null;
}): AlertDraft[] {
  const { prior, next, effectiveStatus, productTitle, competitorHost } = args;
  const drafts: AlertDraft[] = [];

  // Nothing to compare against, or the merchant hasn't OK'd this match.
  if (!prior) return drafts;
  if (!ALERTABLE.has(effectiveStatus)) return drafts;

  const who = competitorHost ?? "competitor";
  const cur = next.currency ?? "";

  // price_drop: both prices known and the new one is strictly lower.
  if (prior.price != null && next.price != null && next.price < prior.price) {
    const drop = Math.round((prior.price - next.price) * 100) / 100;
    drafts.push({
      type: "price_drop",
      message: `${productTitle}: ${who} price dropped ${cur} ${drop} (${cur} ${prior.price} -> ${cur} ${next.price}).`,
      oldValue: String(prior.price),
      newValue: String(next.price),
      currency: next.currency ?? null,
    });
  }

  // back_in_stock: was explicitly out, now explicitly in.
  if (prior.inStock === false && next.inStock === true) {
    drafts.push({
      type: "back_in_stock",
      message: `${productTitle}: ${who} is back in stock.`,
      oldValue: "out_of_stock",
      newValue: "in_stock",
      currency: next.currency ?? null,
    });
  }

  return drafts;
}
