// Bottom status bar showing total API-equivalent usage cost across open sessions.
// Loaded as a plain <script> (module:none) — exposes globals, no import/export.
//
// The figure is computed from transcript token counts × published Anthropic prices
// (see src/cost-tracker.ts). On Bedrock the CLI's own cost is $0, so this is labelled
// an estimate, not the real bill.

function setCost(cost: { total: number; month: number }): void {
  // 4 dp so small sessions don't collapse to $0.00; month is bigger, 2 dp reads cleaner.
  const openEl = document.getElementById('status-cost-value');
  if (openEl) openEl.textContent = `$${(cost?.total ?? 0).toFixed(4)}`;
  const monthEl = document.getElementById('status-cost-month');
  if (monthEl) monthEl.textContent = `$${(cost?.month ?? 0).toFixed(2)}`;
}

function initStatusBar(): void {
  const bar = document.getElementById('status-bar');
  if (!bar) return;
  const estimateTip = 'Estimated API-equivalent cost: transcript tokens × published Anthropic prices. Not your actual bill (e.g. on Bedrock).';
  bar.innerHTML = `
    <span class="status-label" title="${estimateTip} Scope: sessions open in this window.">
      ≈ Open sessions
    </span>
    <span id="status-cost-value" class="status-cost">$0.0000</span>
    <span class="status-sep">·</span>
    <span class="status-label" title="${estimateTip} Scope: all usage across every project this calendar month.">
      this month
    </span>
    <span id="status-cost-month" class="status-cost">$0.00</span>
  `;
  window.api.onCostUpdate(setCost);
  window.api.getCostTotal().then(setCost).catch(() => { /* no sessions yet */ });
}
