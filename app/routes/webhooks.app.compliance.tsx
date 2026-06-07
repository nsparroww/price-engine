import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

// Mandatory GDPR/privacy ("compliance") webhooks. Shopify requires every app to
// handle three topics; this single route receives all of them:
//
//   customers/data_request - a shopper asked the merchant for their data
//   customers/redact       - a shopper asked the merchant to delete their data
//   shop/redact            - 48h after a shop uninstalls, delete shop data
//
// authenticate.webhook() verifies the HMAC signature for us (a failed signature
// throws -> non-200), which is exactly what the App Store "verifies webhooks
// with HMAC" check wants. We then ACK with 200.
//
// Price Engine requests only `read_products` and stores NO buyer/customer
// personal information -- so customers/data_request and customers/redact have
// nothing to return or erase, and we acknowledge them as no-ops (this is the
// correct, honest response for an app that holds no customer PII). For
// shop/redact we remove the shop's own rows so we retain nothing after a shop
// is gone.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, payload } = await authenticate.webhook(request);

  switch (topic) {
    case "CUSTOMERS_DATA_REQUEST":
      // No customer PII stored -> nothing to provide. Acknowledge.
      console.log(`compliance: customers/data_request for ${shop} (no customer data stored)`);
      break;

    case "CUSTOMERS_REDACT":
      // No customer PII stored -> nothing to erase. Acknowledge.
      console.log(`compliance: customers/redact for ${shop} (no customer data stored)`);
      break;

    case "SHOP_REDACT":
      // Shop-level erasure: remove any data we hold for this shop. Best-effort;
      // a failure here must still return 200 so Shopify doesn't retry forever
      // against an already-clean store.
      try {
        const prisma = (await import("../db.server")).default;
        const s = String((payload as any)?.shop_domain ?? shop);
        // Matches (and their observations, via cascade) plus alerts and session.
        await prisma.match.deleteMany({ where: { shop: s } });
        await prisma.alert.deleteMany({ where: { shop: s } });
        await prisma.session.deleteMany({ where: { shop: s } });
        console.log(`compliance: shop/redact erased data for ${s}`);
      } catch (e) {
        console.error("compliance: shop/redact cleanup failed (acked anyway):", e);
      }
      break;

    default:
      console.log(`compliance: unhandled topic ${topic} for ${shop}`);
      break;
  }

  return new Response();
};
