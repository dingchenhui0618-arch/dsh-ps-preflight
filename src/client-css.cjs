// Client styles for dsh-ps-preflight.
//
// Only the host theme is inherited: text and borders are currentColor mixed at
// low alpha, and the three risk accents (red / amber / green) only ever appear
// as low-alpha fills, borders and mixed text. There is no hard-coded panel or
// text colour, so light and dark themes both work from the same sheet.

module.exports = [
  // Layout -----------------------------------------------------------------
  '.ps-root{display:flex;flex-direction:column;gap:16px;padding:16px;height:100%;overflow:auto;color:inherit;font-size:13px;line-height:1.5;box-sizing:border-box;min-width:0}',
  '.ps-head{display:flex;flex-wrap:wrap;align-items:flex-start;gap:8px 16px}',
  '.ps-head-main{flex:1 1 220px;min-width:0}',
  '.ps-title{font-size:15px;font-weight:600;letter-spacing:.01em}',
  '.ps-sub{margin-top:2px;font-size:12px;line-height:1.5;opacity:.6}',
  '.ps-head-actions{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-left:auto}',

  // Badges -----------------------------------------------------------------
  '.ps-badge{display:inline-flex;align-items:center;font-size:11px;line-height:1.7;padding:0 8px;border-radius:999px;border:1px solid transparent;white-space:nowrap;font-weight:500;vertical-align:middle;flex:0 0 auto}',
  '.ps-tone-high{background:color-mix(in srgb,#dc2626 12%,transparent);border-color:color-mix(in srgb,#dc2626 32%,transparent);color:color-mix(in srgb,#dc2626 72%,currentColor)}',
  '.ps-tone-medium{background:color-mix(in srgb,#d97706 12%,transparent);border-color:color-mix(in srgb,#d97706 32%,transparent);color:color-mix(in srgb,#d97706 72%,currentColor)}',
  '.ps-tone-none{background:color-mix(in srgb,#16a34a 12%,transparent);border-color:color-mix(in srgb,#16a34a 32%,transparent);color:color-mix(in srgb,#16a34a 72%,currentColor)}',
  '.ps-tone-good{background:color-mix(in srgb,#16a34a 12%,transparent);border-color:color-mix(in srgb,#16a34a 32%,transparent);color:color-mix(in srgb,#16a34a 72%,currentColor)}',
  '.ps-tone-bad{background:color-mix(in srgb,#dc2626 12%,transparent);border-color:color-mix(in srgb,#dc2626 32%,transparent);color:color-mix(in srgb,#dc2626 72%,currentColor)}',
  '.ps-tone-low{background:color-mix(in srgb,currentColor 8%,transparent);border-color:color-mix(in srgb,currentColor 18%,transparent);color:inherit;opacity:.75}',
  '.ps-tone-muted{background:color-mix(in srgb,currentColor 6%,transparent);border-color:color-mix(in srgb,currentColor 15%,transparent);color:inherit;opacity:.7}',
  '.ps-mode{font-weight:600}',
  '.ps-mode--audit{border-style:dashed}',

  // Buttons and inputs -----------------------------------------------------
  '.ps-btn{appearance:none;border:1px solid color-mix(in srgb,currentColor 22%,transparent);background:transparent;color:inherit;font:inherit;font-size:12px;line-height:1.5;padding:4px 12px;border-radius:8px;cursor:pointer;white-space:nowrap;transition:background .12s ease,border-color .12s ease}',
  '.ps-btn:hover{background:color-mix(in srgb,currentColor 8%,transparent)}',
  '.ps-btn:active{background:color-mix(in srgb,currentColor 14%,transparent)}',
  '.ps-btn:disabled{opacity:.45;cursor:default}',
  '.ps-btn--primary{background:color-mix(in srgb,currentColor 12%,transparent);border-color:color-mix(in srgb,currentColor 34%,transparent);font-weight:600}',
  '.ps-btn--primary:hover{background:color-mix(in srgb,currentColor 18%,transparent)}',
  '.ps-btn--quiet{border-color:color-mix(in srgb,currentColor 14%,transparent);opacity:.85}',
  '.ps-root button:focus-visible,.ps-root textarea:focus-visible{outline:2px solid color-mix(in srgb,currentColor 55%,transparent);outline-offset:2px}',
  '.ps-input{display:block;width:100%;box-sizing:border-box;min-height:72px;margin-top:8px;padding:8px 12px;border:1px solid color-mix(in srgb,currentColor 20%,transparent);border-radius:8px;background:transparent;color:inherit;font-size:12px;line-height:1.6;resize:vertical}',
  '.ps-input::placeholder{color:inherit;opacity:.4}',

  // Stats ------------------------------------------------------------------
  '.ps-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(84px,1fr));gap:8px}',
  '.ps-stat{border:1px solid color-mix(in srgb,currentColor 14%,transparent);border-radius:8px;padding:8px 12px;min-width:0}',
  '.ps-stat b{display:block;font-size:18px;font-weight:600;line-height:1.2;font-variant-numeric:tabular-nums}',
  '.ps-stat span{display:block;font-size:11px;opacity:.6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
  '.ps-stat--bad b{color:#dc2626}',
  '.ps-stat--good b{color:#16a34a}',

  // Cards ------------------------------------------------------------------
  '.ps-card{border:1px solid color-mix(in srgb,currentColor 14%,transparent);border-radius:10px;padding:16px;min-width:0}',
  '.ps-card-head{display:flex;flex-wrap:wrap;align-items:baseline;gap:8px}',
  '.ps-card-title{margin:0;font-size:12px;font-weight:600;opacity:.8}',
  '.ps-hint{font-size:11px;opacity:.55}',
  '.ps-try-foot{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:8px}',
  '.ps-try-note{margin-right:auto;font-size:11px;opacity:.5}',

  // Local analysis result --------------------------------------------------
  '.ps-result{display:flex;flex-direction:column;gap:8px;margin-top:16px;padding-top:16px;border-top:1px solid color-mix(in srgb,currentColor 10%,transparent)}',
  '.ps-result-head{display:flex;flex-wrap:wrap;align-items:center;gap:8px}',
  '.ps-summary{font-size:12px;opacity:.8;min-width:0;overflow-wrap:anywhere}',
  '.ps-score{font-size:11px;opacity:.5;font-variant-numeric:tabular-nums}',
  '.ps-escalated{font-size:12px;color:color-mix(in srgb,#d97706 72%,currentColor)}',
  '.ps-findings{display:flex;flex-direction:column;gap:4px;min-width:0}',
  '.ps-finding{display:flex;flex-wrap:wrap;align-items:baseline;gap:2px 8px;font-size:12px;min-width:0}',
  '.ps-finding-label{font-weight:500}',
  '.ps-evidence{font-size:11px;opacity:.55;overflow-wrap:anywhere}',
  '.ps-more{font-size:11px;opacity:.5}',
  '.ps-verdict{font-size:12px;line-height:1.6}',
  '.ps-try-err{margin-top:8px}',

  // Pending confirmations --------------------------------------------------
  '.ps-section{display:flex;flex-direction:column;gap:8px;min-width:0}',
  '.ps-section-head{display:flex;flex-wrap:wrap;align-items:baseline;gap:8px}',
  '.ps-section-title{font-size:12px;font-weight:600;opacity:.8}',
  '.ps-pend-list{display:flex;flex-direction:column;gap:8px;min-width:0}',
  '.ps-pend{border:1px solid color-mix(in srgb,#d97706 42%,transparent);background:color-mix(in srgb,#d97706 6%,transparent);border-radius:10px;padding:12px 16px;display:flex;flex-direction:column;gap:8px;min-width:0}',
  '.ps-pend--high{border-color:color-mix(in srgb,#dc2626 45%,transparent);background:color-mix(in srgb,#dc2626 6%,transparent)}',
  '.ps-pend-head{display:flex;flex-wrap:wrap;align-items:center;gap:8px}',
  '.ps-pend-sum{font-size:12px;opacity:.8;min-width:0;overflow-wrap:anywhere}',
  '.ps-count{margin-left:auto;font-size:11px;font-variant-numeric:tabular-nums;opacity:.65;white-space:nowrap}',
  '.ps-pend-cmd{font-size:12px;white-space:pre-wrap;overflow-wrap:anywhere;padding:8px 12px;border-radius:8px;background:color-mix(in srgb,currentColor 5%,transparent);max-height:96px;overflow:auto;min-width:0}',
  '.ps-pend-foot{display:flex;flex-wrap:wrap;align-items:center;justify-content:flex-end;gap:8px}',

  // Recent records ---------------------------------------------------------
  '.ps-recent{display:flex;flex-direction:column;gap:8px;margin-top:8px}',
  '.ps-row{border:1px solid color-mix(in srgb,currentColor 12%,transparent);border-radius:8px;padding:8px 12px;display:flex;flex-direction:column;gap:4px;min-width:0}',
  '.ps-row--deny{border-color:color-mix(in srgb,#dc2626 38%,transparent)}',
  '.ps-row-top{display:flex;flex-wrap:wrap;align-items:center;gap:4px 8px;min-width:0}',
  '.ps-time{font-size:11px;opacity:.55;font-variant-numeric:tabular-nums}',
  '.ps-cats{display:flex;flex-wrap:wrap;gap:4px;min-width:0}',
  '.ps-cat{font-size:10px;line-height:1.6;padding:0 6px;border-radius:4px;border:1px solid color-mix(in srgb,currentColor 16%,transparent);opacity:.6;white-space:nowrap}',
  '.ps-row-top .ps-badge:last-child{margin-left:auto}',
  '.ps-cmd{font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;opacity:.85;min-width:0}',
  '.ps-reason{font-size:11px;opacity:.55;overflow-wrap:anywhere}',
  '.ps-empty{font-size:12px;opacity:.55;padding:8px 0}',

  // Footer and errors ------------------------------------------------------
  '.ps-foot{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 8px;font-size:11px;opacity:.5;min-width:0;padding-bottom:8px}',
  '.ps-path{overflow-wrap:anywhere;min-width:0}',
  '.ps-foot-sep{opacity:.7}',
  '.ps-err{border:1px solid color-mix(in srgb,#dc2626 48%,transparent);background:color-mix(in srgb,#dc2626 8%,transparent);border-radius:8px;padding:8px 12px;font-size:12px;overflow-wrap:anywhere}',
  '.ps-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace}',
].join('')
