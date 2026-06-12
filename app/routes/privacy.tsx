import type { MetaFunction } from "react-router";

// PUBLIC route -- intentionally no authenticate.admin(). The App Store reviewer
// (and merchants) must be able to open this URL directly while logged out, so it
// renders plain semantic HTML with inline styles and needs no Polaris / App
// Bridge context. Served at /privacy on the app domain.
//
// The content reflects Price Engine's ACTUAL data behavior: the only Shopify
// scope is read_products; competitor prices/stock are read from public web
// pages; no buyer/customer personal information is requested, accessed, or
// stored. Keep this in sync with shopify.app.toml `scopes` if that ever changes.

export const meta: MetaFunction = () => [
  { title: "Price Engine - Privacy Policy" },
  {
    name: "description",
    content: "How Price Engine handles data for Shopify merchants.",
  },
];

const LAST_UPDATED = "June 12, 2026";

const pageStyle: React.CSSProperties = {
  maxWidth: "720px",
  margin: "0 auto",
  padding: "48px 24px",
  fontFamily:
    '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  lineHeight: 1.6,
  color: "#202223",
};

const h1Style: React.CSSProperties = {
  fontSize: "28px",
  fontWeight: 700,
  marginBottom: "4px",
};

const h2Style: React.CSSProperties = {
  fontSize: "18px",
  fontWeight: 600,
  marginTop: "32px",
  marginBottom: "8px",
};

const mutedStyle: React.CSSProperties = {
  color: "#6d7175",
  fontSize: "14px",
  marginBottom: "24px",
};

export default function Privacy() {
  return (
    <main style={pageStyle}>
      <h1 style={h1Style}>Privacy Policy</h1>
      <p style={mutedStyle}>Last updated: {LAST_UPDATED}</p>

      <p>
        Price Engine ("we", "us", or "the app") is a Shopify app that monitors
        competitor prices and stock for a merchant's catalog. This policy
        explains what data the app accesses, why, and how it is handled. We have
        designed the app to request as little data as possible.
      </p>

      <h2 style={h2Style}>Data we access from your store</h2>
      <p>
        Price Engine requests a single Shopify permission:{" "}
        <strong>read access to your products</strong> (the{" "}
        <code>read_products</code> scope). We use this only to read your product
        catalog -- titles, brand/vendor, prices, and identifiers such as SKU and
        barcode (GTIN) -- so the app can find matching products on competitor
        sites. We do not request access to your orders, customers, or any buyer
        personal information, and the app cannot read that data.
      </p>

      <h2 style={h2Style}>Competitor data</h2>
      <p>
        To monitor competitors, the app reads publicly available product pages on
        competitor websites (the same pages any shopper can view) and records the
        price and stock status it finds, along with a timestamp. This is public
        commercial information; it does not include any personal data.
      </p>

      <h2 style={h2Style}>Data we store</h2>
      <p>
        We store the minimum needed to provide the service: your store's domain;
        the product, competitor URL, and match records you create; and the
        time-series of price and stock readings the app collects. We store an
        access token issued by Shopify so the app can read your catalog on your
        behalf. We do not store buyer or customer personal information.
      </p>

      <h2 style={h2Style}>How we use the data</h2>
      <p>
        Data is used solely to operate the app for your store: matching your
        products to competitors, tracking price and stock changes over time, and
        sending you the alerts you configure. We do not sell your data, and we do
        not use it for advertising.
      </p>

      <h2 style={h2Style}>Sharing</h2>
      <p>
        We do not sell or rent your data. We share it only with the
        infrastructure providers required to run the app (for example, our
        application host, database host, and the matching engine), which process
        data on our behalf and only to deliver the service. We may disclose data
        if required by law.
      </p>

      <h2 style={h2Style}>Data retention and deletion</h2>
      <p>
        When you uninstall Price Engine, your access token is revoked and we stop
        collecting data for your store. We honor Shopify's mandatory data
        protection webhooks. You can request deletion of your store's data at any
        time using the contact below, and we will delete it.
      </p>

      <h2 style={h2Style}>Changes to this policy</h2>
      <p>
        We may update this policy as the app evolves. Material changes will be
        reflected by the "Last updated" date above.
      </p>

      <h2 style={h2Style}>Contact</h2>
      <p>
        Questions about this policy or your data? Contact us at{" "}
        <a href="mailto:admin@trackaura.com">admin@trackaura.com</a>.
      </p>
    </main>
  );
}
