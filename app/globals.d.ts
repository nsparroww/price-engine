declare module "*.css";

// Polaris web component used in app.tsx but missing from Shopify's shipped JSX
// typings (its siblings s-page / s-section / s-button resolve; s-app-nav does
// not). Interface declarations merge, so this ADDS the one missing element to
// the existing JSX.IntrinsicElements without overriding the package's types.
declare namespace JSX {
  interface IntrinsicElements {
    "s-app-nav": any;
  }
}
