import type { LoaderFunctionArgs } from "react-router";
import { redirect, Form, useLoaderData } from "react-router";
import { login } from "../../shopify.server";
import styles from "./styles.module.css";
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }
  return { showForm: Boolean(login) };
};
export default function App() {
  const { showForm } = useLoaderData<typeof loader>();
  return (
    <div className={styles.index}>
      <div className={styles.content}>
        <h1 className={styles.heading}>Price Engine</h1>
        <p className={styles.text}>
          Automatically monitor your competitors' prices and stock. No pasting
          URLs, no spreadsheets &mdash; just accurate, auto-matched competitor
          data inside your Shopify admin.
        </p>
        {showForm && (
          <Form className={styles.form} method="post" action="/auth/login">
            <label className={styles.label}>
              <span>Shop domain</span>
              <input className={styles.input} type="text" name="shop" />
              <span>e.g: my-shop-domain.myshopify.com</span>
            </label>
            <button className={styles.button} type="submit">
              Log in
            </button>
          </Form>
        )}
        <ul className={styles.list}>
          <li>
            <strong>Automatic competitor discovery</strong>. Finds the same
            products on competitor sites for you &mdash; no manual URL hunting.
          </li>
          <li>
            <strong>Accurate price &amp; stock tracking</strong>. Reads
            structured product data first, so your numbers stay correct through
            site redesigns.
          </li>
          <li>
            <strong>Confidence-scored matches &amp; alerts</strong>. Every match
            carries a confidence score, and you're alerted on price drops,
            undercuts, and back-in-stock.
          </li>
        </ul>
      </div>
    </div>
  );
}
