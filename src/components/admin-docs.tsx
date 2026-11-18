const currency = (value: number) => value.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const referenceRate = 93.3558;
const sampleRequests = 36;
const inputTokens = 81958 / sampleRequests, outputTokens = 7628 / sampleRequests;
const inputCost = inputTokens * .25 / 1_000_000 * referenceRate;
const outputCost = outputTokens * 1.5 / 1_000_000 * referenceRate;
const replyCost = inputCost + outputCost;

export function AdminDocs({ billingRate }: { billingRate: number }) {
  return <article className="admin-docs" aria-labelledby="admin-docs-title">
    <p className="eyebrow">Docs</p>
    <h1 id="admin-docs-title">Cost calculation</h1>
    <p className="page-subtitle">How API costs become credits in Daywell.</p>
    <p className="docs-snapshot">Reference snapshot · 18 November 2026. Based on 36 successful production requests. These figures are saved examples, not live usage averages.</p>

    <section aria-labelledby="docs-api-prices">
      <h2 id="docs-api-prices">1. API prices</h2>
      <p>Model: Gemini 3.1 Flash-Lite, standard API pricing. The reference conversion is ₹{currency(referenceRate)} per US dollar.</p>
      <div className="table-scroll"><table className="docs-table"><caption className="sr-only">API prices per million tokens</caption>
        <thead><tr><th scope="col">Type</th><th scope="col">USD per million tokens</th><th scope="col">INR per million tokens</th></tr></thead>
        <tbody><tr><th scope="row">Input API cost</th><td>$0.25</td><td>₹{currency(.25 * referenceRate)}</td></tr><tr><th scope="row">Output API cost</th><td>$1.50</td><td>₹{currency(1.5 * referenceRate)}</td></tr></tbody>
      </table></div>
      <p className="docs-note">Input includes messages, photos and context. Output includes generated replies and thinking tokens. Sources: <a href="https://aistudio.google.com/docs/pricing#gemini-3.1-flash-lite" target="_blank" rel="noopener noreferrer">Google API pricing</a> and <a href="https://www.rbi.org.in/?Id=3934" target="_blank" rel="noopener noreferrer">RBI reference exchange rate</a>.</p>
    </section>

    <section aria-labelledby="docs-typical-reply">
      <h2 id="docs-typical-reply">2. Typical tokens and cost per reply</h2>
      <div className="table-scroll"><table className="docs-table"><caption className="sr-only">Average tokens and reference cost per reply</caption>
        <thead><tr><th scope="col">Type</th><th scope="col">Average tokens per reply</th><th scope="col">Cost per reply</th></tr></thead>
        <tbody><tr><th scope="row">Input</th><td>{currency(inputTokens)}</td><td>₹{currency(inputCost)}</td></tr><tr><th scope="row">Output</th><td>{currency(outputTokens)}</td><td>₹{currency(outputCost)}</td></tr><tr className="docs-total"><th scope="row">Total</th><td>{currency(inputTokens + outputTokens)}</td><td>₹{currency(replyCost)}</td></tr></tbody>
      </table></div>
      <p className="docs-formula">Cost per reply = (input tokens × input price + output tokens × output price) ÷ 1,000,000 × exchange rate.</p>
      <p>If 18% GST applies to your Google invoice, this sample costs <strong>₹{currency(replyCost * 1.18)} per reply</strong> including GST. Your invoice determines the actual conversion and taxes. <a href="https://docs.cloud.google.com/billing/docs/resources/vat-overview" target="_blank" rel="noopener noreferrer">Google tax documentation</a>.</p>
    </section>

    <section aria-labelledby="docs-multiplier">
      <h2 id="docs-multiplier">3. Apply the multiplier</h2>
      <p>The multiplier sets the markup on the calculated cost. At 2.50×:</p>
      <div className="table-scroll"><table className="docs-table"><caption className="sr-only">Reference selling price at a 2.50 multiplier</caption>
        <thead><tr><th scope="col">Cost basis</th><th scope="col">Cost per reply</th><th scope="col">Selling price</th></tr></thead>
        <tbody><tr><th scope="row">Excluding GST</th><td>₹{currency(replyCost)}</td><td>₹{currency(replyCost * 2.5)}</td></tr><tr><th scope="row">Including 18% GST, if applicable</th><td>₹{currency(replyCost * 1.18)}</td><td>₹{currency(replyCost * 1.18 * 2.5)}</td></tr></tbody>
      </table></div>
      <p className="docs-note">All displayed values use two decimal places. Calculations retain full precision before rounding, including the exchange rate, so multiplying the displayed rounded values can give a different result.</p>
    </section>

    <section aria-labelledby="docs-current-billing">
      <h2 id="docs-current-billing">4. How the app currently bills</h2>
      <p>One credit represents ₹1. The app currently uses a fixed billing conversion of <strong>₹{currency(billingRate)} per US dollar</strong>, rather than the reference rate above. GST is not added separately to credit deductions.</p>
      <p className="docs-formula">Credits charged = recorded API cost in USD × billing conversion × the user’s multiplier.</p>
      <p>Each request’s USD cost is recorded rounded up to a micro-dollar, then its credit charge is rounded up to 0.01 credit. Photos and conversation length change the cost; the number of replies remaining is estimated from that user’s last 10 successful, metered requests (or a starter estimate without usage history).</p>
      <p>New account defaults are editable in Community. Changing those defaults affects future signups; an existing account’s multiplier is edited separately. Credit additions never change the multiplier.</p>
    </section>
  </article>;
}
