import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import prisma from "../db.server";
import { recheckMatch } from "../lib/recheck.server";
import { RECHECK_SECRET } from "../recheck-config.server";

// Internal re-check endpoint. NO Shopify session: it runs purely off persisted
// Match rows + the engine, which is exactly why steps 1-2 snapshotted the
// merchant identifiers onto the row. A timer/cron POSTs here on a cadence.
//
// It triggers live scrapes and DB writes, so it is guarded by a shared secret
// and must never be exposed publicly (the production engine-privacy decision,
// applied to this endpoint too).

const DELAY_MS = 1500; // polite gap between scrapes within one pass

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.headers.get("x-recheck-secret") !== RECHECK_SECRET) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }

  // Every tracked (non-rejected) match, oldest-checked first so a cadence
  // naturally round-robins. All shops (single-process, so Prisma serializes
  // writes - no second OS-level SQLite writer).
  const matches = await prisma.match.findMany({
    where: { status: { not: "rejected" } },
    orderBy: { updatedAt: "asc" },
  });

  const results: Array<Record<string, unknown>> = [];
  for (const m of matches) {
    const merchant = {
      id: m.productGid,
      title: m.productTitle,
      brand: m.productBrand,
      gtin: m.productGtin,
      sku: m.productSku,
    };

    try {
      const r = await recheckMatch({
        shop: m.shop,
        merchant,
        competitorUrl: m.competitorUrl,
      });
      results.push({
        matchId: m.id,
        competitorUrl: m.competitorUrl,
        ok: r.error == null,
        saved: r.saved,
        error: r.error,
        price: r.result?.price ?? null,
        status: r.result?.status ?? null,
      });
    } catch (e: any) {
      // One bad row must never kill the pass.
      results.push({
        matchId: m.id,
        competitorUrl: m.competitorUrl,
        ok: false,
        saved: false,
        error: `Uncaught: ${e?.message ?? e}`,
      });
    }

    if (matches.length > 1) {
      await new Promise((res) => setTimeout(res, DELAY_MS));
    }
  }

  return Response.json({
    checked: results.length,
    at: new Date().toISOString(),
    results,
  });
};

// GET must not trigger scrapes.
export const loader = async (_args: LoaderFunctionArgs) => {
  return Response.json(
    { error: "POST with the x-recheck-secret header to run a re-check pass." },
    { status: 405 },
  );
};
