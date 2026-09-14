/**
 * The Kaizen course-invoice screen and its printed ledger, styled to match
 * the reference tool this feature reproduces — deliberately its own visual
 * language (black/gold/navy, Archivo Black headings, thick hairline borders)
 * rather than the app's usual glass/depth system, because the brief is
 * fidelity to that reference down to the pixel, not house-style consistency.
 *
 * Every selector is scoped under `.ki-app` (the interactive screen) or
 * `#ki-print-root` (the print portal, rendered outside `#root` via a React
 * portal so `@media print` can hide the rest of the app the same way the
 * reference hides everything but its own print root) — the app already has
 * a `.btn-primary` etc. of its own, and these must never collide with it.
 */

export const KI_TOKENS = `
  --ki-black:#0D0D12;
  --ki-navy:#14163F;
  --ki-gold:#F6B429;
  --ki-gold-dark:#D89A1E;
  --ki-gold-soft:#FDF0CE;
  --ki-paper:#FAFAF8;
  --ki-panel:#FFFFFF;
  --ki-ink:#1C1E24;
  --ki-muted:#6B6C72;
  --ki-line:#E5E3DA;
  --ki-line-strong:#D2D0C4;
  --ki-red:#B5432E;
  --ki-radius:8px;
`;

export const KI_APP_CSS = `
.ki-app{
  ${KI_TOKENS}
  background:var(--ki-paper);
  color:var(--ki-ink);
  font-family:'IBM Plex Sans',sans-serif;
  font-size:14px;
  line-height:1.5;
  -webkit-font-smoothing:antialiased;
  border-radius:16px;
  overflow:hidden;
  border:1.5px solid var(--ki-black);
}
.ki-app *{box-sizing:border-box;}
.ki-app h1,.ki-app h2,.ki-app h3,.ki-app .ki-brand,.ki-app .ki-display{font-family:'Archivo Black',sans-serif;font-weight:400;letter-spacing:-0.01em;}
.ki-app .ki-num{font-variant-numeric:tabular-nums;}
.ki-app .ki-pill-tag{
  display:inline-flex;align-items:center;border:1.5px solid currentColor;border-radius:999px;
  padding:3px 12px;font-size:10.5px;font-weight:700;letter-spacing:0.07em;text-transform:uppercase;
}

.ki-app .ki-topbar{
  background:var(--ki-black);
  color:#fff;
  display:flex;
  align-items:center;
  justify-content:space-between;
  flex-wrap:wrap;
  gap:10px 16px;
  padding:14px 28px;
  border-bottom:4px solid var(--ki-gold);
}
.ki-app .ki-brandblock{display:flex;align-items:center;gap:12px;}
.ki-app .ki-brandblock img{height:32px;width:auto;display:block;flex-shrink:0;}
.ki-app .ki-brandtext .ki-brand{font-size:18px;font-weight:400;letter-spacing:-0.01em;line-height:1.1;white-space:nowrap;}
.ki-app .ki-brandtext .ki-tag{font-size:11px;color:#B7B8C9;margin-top:2px;font-weight:500;}
.ki-app .ki-tabs{display:flex;gap:8px;flex-wrap:wrap;}
.ki-app .ki-tab-btn{
  background:transparent;border:1.5px solid rgba(255,255,255,0.35);color:#F2F2F7;
  font-family:'IBM Plex Sans',sans-serif;font-size:12.5px;font-weight:700;letter-spacing:0.03em;
  padding:8px 18px;border-radius:999px;cursor:pointer;transition:all .15s ease;white-space:nowrap;
}
.ki-app .ki-tab-btn:hover{border-color:var(--ki-gold);color:var(--ki-gold);}
.ki-app .ki-tab-btn.active{background:var(--ki-gold);border-color:var(--ki-gold);color:var(--ki-black);}

@media (max-width:560px){
  .ki-app .ki-topbar{padding:12px 16px;gap:10px;}
  .ki-app .ki-brandblock img{height:26px;}
  .ki-app .ki-brandtext .ki-brand{font-size:15px;}
  .ki-app .ki-brandtext .ki-tag{font-size:9.5px;}
  .ki-app .ki-tabs{width:100%;}
  .ki-app .ki-tab-btn{flex:1;text-align:center;padding:9px 10px;font-size:11.5px;}
}

.ki-app main.ki-main{padding:24px 28px 64px;}
@media (max-width:560px){.ki-app main.ki-main{padding:16px 14px 48px;}}

.ki-app .ki-layout{display:grid;grid-template-columns:300px 1fr;gap:22px;align-items:start;}
.ki-app .ki-layout > .ki-panel{min-width:0;}
@media (max-width:980px){.ki-app .ki-layout{grid-template-columns:1fr;}}

.ki-app .ki-panel{
  background:var(--ki-panel);
  border:1.5px solid var(--ki-black);
  border-radius:14px;
}
.ki-app .ki-panel-head{
  padding:13px 18px;border-bottom:1.5px solid var(--ki-black);
  font-family:'Archivo Black',sans-serif;font-weight:400;font-size:15px;color:var(--ki-black);
  display:flex;align-items:center;justify-content:space-between;
}
.ki-app .ki-panel-body{padding:18px;}

.ki-app .ki-field{margin-bottom:13px;}
.ki-app .ki-field label{display:block;font-size:11.5px;color:var(--ki-muted);margin-bottom:4px;font-weight:600;}
.ki-app .ki-field input[type=text],
.ki-app .ki-field input[type=number],
.ki-app .ki-field input[type=date],
.ki-app .ki-field input[type=tel],
.ki-app .ki-field select{
  width:100%;padding:8px 10px;border:1.5px solid var(--ki-line-strong);border-radius:7px;
  font-family:'IBM Plex Sans',sans-serif;font-size:13.5px;color:var(--ki-ink);background:#fff;
}
.ki-app .ki-field input:focus,.ki-app .ki-field select:focus{outline:2px solid var(--ki-gold);outline-offset:0;border-color:var(--ki-gold-dark);}
.ki-app .ki-field .ki-hint{font-size:11px;color:var(--ki-muted);margin-top:3px;}
.ki-app .ki-field-row{display:flex;gap:8px;}
@media (max-width:380px){.ki-app .ki-field-row{flex-direction:column;}}
.ki-app .ki-field-row .ki-field{flex:1;}

.ki-app .ki-course-entry{
  border:1.5px solid var(--ki-black);border-radius:12px;padding:12px;margin-bottom:12px;background:#fff;
}
.ki-app .ki-course-entry-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;}
.ki-app .ki-course-entry-head span{font-size:12px;color:var(--ki-black);font-weight:700;font-family:'Archivo Black',sans-serif;font-weight:400;}

.ki-app .ki-addon-row{
  border:1.5px solid var(--ki-line-strong);border-radius:10px;padding:10px;margin-bottom:8px;background:#FCFCFA;
}
.ki-app .ki-addon-row-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;}
.ki-app .ki-addon-row-head span{font-size:11.5px;color:var(--ki-muted);font-weight:700;}
.ki-app .ki-btn-remove{
  background:none;border:none;color:var(--ki-red);font-size:12px;cursor:pointer;font-weight:600;padding:2px 4px;
}
.ki-app .ki-btn-remove:hover{text-decoration:underline;}
.ki-app .ki-btn-add{
  width:100%;padding:9px;border:1.5px dashed var(--ki-line-strong);border-radius:999px;
  background:none;color:var(--ki-black);font-family:'IBM Plex Sans',sans-serif;font-size:13px;font-weight:700;
  cursor:pointer;margin-top:4px;
}
.ki-app .ki-btn-add:hover{border-color:var(--ki-gold-dark);color:var(--ki-gold-dark);background:var(--ki-gold-soft);}
.ki-app .ki-btn-add:disabled{opacity:0.4;cursor:not-allowed;}
.ki-app .ki-btn-add.small{padding:7px;font-size:12px;margin-top:2px;}

.ki-app .ki-ledger-section-label{
  padding:10px 22px 0;font-size:12px;font-weight:700;color:var(--ki-black);
  display:flex;align-items:center;gap:8px;
}
.ki-app .ki-ledger-section-label .ki-n{
  background:var(--ki-gold);color:var(--ki-black);border-radius:999px;width:20px;height:20px;
  display:inline-flex;align-items:center;justify-content:center;font-size:11px;font-family:'Archivo Black',sans-serif;font-weight:400;
}
.ki-app .ki-ledger-section{border-bottom:3px solid var(--ki-line-strong);}
.ki-app .ki-ledger-section:last-of-type{border-bottom:none;}
.ki-app .ki-combined-summary{
  padding:14px 22px;background:var(--ki-black);color:#fff;display:flex;justify-content:space-between;
  align-items:center;flex-wrap:wrap;gap:8px;font-size:12px;
}
.ki-app .ki-combined-summary b{color:var(--ki-gold);font-family:'Archivo Black',sans-serif;font-weight:400;font-size:16px;}

.ki-app .ki-btn-primary{
  width:100%;padding:12px;border:1.5px solid var(--ki-black);border-radius:999px;
  background:var(--ki-black);color:#fff;font-family:'IBM Plex Sans',sans-serif;font-size:14px;font-weight:700;
  cursor:pointer;margin-top:8px;transition:all .15s ease;
}
.ki-app .ki-btn-primary:hover:not(:disabled){background:var(--ki-gold);border-color:var(--ki-gold);color:var(--ki-black);}
.ki-app .ki-btn-primary:disabled{opacity:0.5;cursor:not-allowed;}
.ki-app .ki-btn-secondary{
  width:100%;padding:9px;border:1.5px solid var(--ki-line-strong);border-radius:999px;
  background:#fff;color:var(--ki-ink);font-family:'IBM Plex Sans',sans-serif;font-size:13px;font-weight:700;
  cursor:pointer;margin-top:8px;
}
.ki-app .ki-btn-secondary:hover{border-color:var(--ki-black);}

.ki-app .ki-ledger-head{
  display:flex;align-items:center;gap:14px;padding:18px 22px 14px;border-bottom:3px solid var(--ki-black);
}
.ki-app .ki-ledger-head img{height:44px;}
.ki-app .ki-ledger-head .ki-co h2{margin:0;font-size:19px;color:var(--ki-black);font-weight:400;}
.ki-app .ki-ledger-head .ki-co .ki-sub{font-size:12px;color:var(--ki-muted);}
.ki-app .ki-ledger-head .ki-meta{margin-left:auto;text-align:right;font-size:11px;color:var(--ki-muted);}
.ki-app .ki-ledger-head .ki-meta .ki-addr{max-width:320px;}

.ki-app .ki-info-strip{
  display:grid;grid-template-columns:1fr 1fr;gap:0 24px;padding:14px 22px;border-bottom:1px solid var(--ki-line);
  font-size:13px;
}
.ki-app .ki-info-strip .ki-row{display:flex;justify-content:space-between;padding:3px 0;border-bottom:1px dotted var(--ki-line);}
.ki-app .ki-info-strip .ki-row .ki-k{color:var(--ki-muted);}
.ki-app .ki-info-strip .ki-row .ki-v{font-weight:700;}

.ki-app .ki-schedule-strip{
  display:grid;grid-template-columns:repeat(4,1fr);gap:10px;padding:14px 22px;border-bottom:1px solid var(--ki-line);
}
.ki-app .ki-schedule-strip .ki-item{padding:9px 12px;border:1.5px solid var(--ki-black);border-radius:10px;}
.ki-app .ki-schedule-strip .ki-item .ki-k{font-size:10px;color:var(--ki-muted);text-transform:none;}
.ki-app .ki-schedule-strip .ki-item .ki-v{font-size:13.5px;font-weight:700;color:var(--ki-black);margin-top:2px;}

.ki-app table.ki-ledger{width:100%;min-width:900px;border-collapse:collapse;font-size:12.5px;}
.ki-app table.ki-ledger th{
  background:var(--ki-black);color:#fff;font-weight:700;font-size:11px;text-align:center;
  padding:8px 6px;border:1px solid var(--ki-black);
}
.ki-app table.ki-ledger td{padding:7px 6px;border:1px solid var(--ki-line);text-align:center;}
.ki-app table.ki-ledger td.ki-name-cell{text-align:left;}
.ki-app table.ki-ledger tr.ki-course-row{background:var(--ki-gold-soft);font-weight:700;}
.ki-app table.ki-ledger tr.ki-addon-row-r td{color:var(--ki-ink);}
.ki-app table.ki-ledger td.ki-total-cell{font-weight:700;}
.ki-app .ki-ledger-scroll{overflow-x:auto;padding:0 22px;}

.ki-app .ki-totals-strip{
  display:flex;justify-content:space-between;align-items:center;padding:16px 22px;border-top:3px solid var(--ki-black);
}
.ki-app .ki-totals-strip .ki-words{font-size:12px;color:var(--ki-muted);max-width:56%;}
.ki-app .ki-totals-strip .ki-words b{color:var(--ki-ink);}
.ki-app .ki-totals-strip .ki-grand{text-align:right;background:var(--ki-gold);border-radius:12px;padding:10px 20px;}
.ki-app .ki-totals-strip .ki-grand .ki-lbl{font-size:10.5px;color:var(--ki-black);font-weight:600;}
.ki-app .ki-totals-strip .ki-grand .ki-amt{font-size:24px;color:var(--ki-black);font-family:'Archivo Black',sans-serif;font-weight:400;}

.ki-app .ki-note-strip{padding:10px 22px 18px;font-size:10.5px;color:var(--ki-muted);line-height:1.6;border-top:1px solid var(--ki-line);}
.ki-app .ki-sign-strip{display:flex;justify-content:space-between;padding:26px 22px 20px;font-size:11.5px;color:var(--ki-muted);}
.ki-app .ki-sign-strip .ki-line{border-top:1.5px solid var(--ki-black);padding-top:5px;width:220px;text-align:center;}

.ki-app .ki-empty-note{padding:40px;text-align:center;color:var(--ki-muted);font-size:13px;}

@media (max-width:700px){
  .ki-app .ki-ledger-head{flex-wrap:wrap;padding:16px 16px 12px;}
  .ki-app .ki-ledger-head .ki-meta{margin-left:0;text-align:left;}
  .ki-app .ki-ledger-head .ki-meta .ki-addr{max-width:none;}
  .ki-app .ki-info-strip{grid-template-columns:1fr;padding:12px 16px;}
  .ki-app .ki-schedule-strip{grid-template-columns:1fr 1fr;padding:12px 16px;}
  .ki-app .ki-ledger-scroll{padding:0 16px;}
  .ki-app .ki-totals-strip{flex-direction:column;align-items:flex-start;gap:12px;padding:14px 16px;}
  .ki-app .ki-totals-strip .ki-words{max-width:100%;}
  .ki-app .ki-totals-strip .ki-grand{align-self:stretch;text-align:left;}
  .ki-app .ki-note-strip{padding:10px 16px 16px;}
  .ki-app .ki-sign-strip{flex-direction:column;gap:24px;padding:20px 16px;}
  .ki-app .ki-sign-strip .ki-line{width:100%;}
}
@media (max-width:420px){
  .ki-app .ki-schedule-strip{grid-template-columns:1fr;}
}

.ki-app .ki-catalog-toolbar{display:flex;gap:10px;margin-bottom:16px;align-items:center;flex-wrap:wrap;}
.ki-app .ki-catalog-toolbar input{
  flex:1;max-width:360px;padding:9px 14px;border:1.5px solid var(--ki-line-strong);border-radius:999px;
  font-family:'IBM Plex Sans',sans-serif;font-size:13.5px;
}
.ki-app .ki-catalog-toolbar .ki-count{font-size:12px;color:var(--ki-muted);font-weight:600;}
.ki-app .ki-cat-section{margin-bottom:28px;}
.ki-app .ki-cat-section h3{font-size:17px;color:var(--ki-black);margin:0 0 10px;padding-bottom:7px;border-bottom:3px solid var(--ki-gold);font-weight:400;}
.ki-app .ki-cat-scroll{overflow-x:auto;border:1px solid var(--ki-line);border-radius:var(--ki-radius);}
.ki-app table.ki-cat{width:100%;min-width:760px;border-collapse:collapse;font-size:12.5px;background:#fff;}
.ki-app table.ki-cat th{background:var(--ki-black);color:#fff;font-size:10.5px;font-weight:700;text-align:left;padding:8px 8px;position:sticky;top:0;}
.ki-app table.ki-cat td{padding:7px 8px;border-bottom:1px solid var(--ki-line);vertical-align:top;}
.ki-app table.ki-cat tr:hover td{background:var(--ki-gold-soft);}
.ki-app table.ki-cat td.ki-num-cell{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap;}
.ki-app table.ki-cat td.ki-notes-cell{color:var(--ki-muted);font-size:11.5px;max-width:280px;}
.ki-app .ki-badge{display:inline-block;padding:1px 7px;border-radius:10px;font-size:10px;font-weight:700;}
.ki-app .ki-badge.ki-na{background:#EFEFE9;color:var(--ki-muted);}
`;

/**
 * The printed ledger — a completely separate, self-contained stylesheet from
 * `KI_APP_CSS`, because it is rendered through a portal outside the app
 * shell entirely (see `PrintPortal`), the same way the reference prints only
 * its own `#printRoot` and hides everything else on the page.
 */
export const KI_PRINT_CSS = `
@media print{
  body > *:not(#ki-print-root){display:none !important;}
  @page{size:A4 portrait;margin:0;}
  #ki-print-root{display:block !important;width:210mm;}
}
#ki-print-root{
  ${KI_TOKENS}
  display:none;
  font-family:'IBM Plex Sans',sans-serif;
  color:var(--ki-ink);
}
@media print{
  #ki-print-root .ki-print-page{
    display:grid;
    grid-template-rows:145.5mm 6mm 145.5mm;
    width:210mm;height:297mm;
    page-break-after:always;break-after:page;
  }
  #ki-print-root .ki-print-page:last-child{page-break-after:auto;break-after:auto;}
  #ki-print-root .ki-print-half{
    box-sizing:border-box;width:210mm;padding:6mm 10mm;
    display:flex;align-items:center;justify-content:center;overflow:hidden;
  }
  #ki-print-root .ki-fold-line{
    display:flex;align-items:center;justify-content:center;
    border-top:1px dashed #888;border-bottom:1px dashed #888;
    font-size:7px;color:#888;letter-spacing:0.08em;
  }
  #ki-print-root .ki-print-copy{width:100%;border:1.5px solid var(--ki-black);border-radius:8px;padding:4px 7px 3px;box-sizing:border-box;}

  #ki-print-root .ki-ledger-head{display:flex;align-items:center;gap:8px;padding:4px 6px;border-bottom:2px solid var(--ki-black);}
  #ki-print-root .ki-ledger-head img{height:24px;}
  #ki-print-root .ki-ledger-head .ki-co h2{margin:0;font-size:13px;font-weight:400;font-family:'Archivo Black',sans-serif;}
  #ki-print-root .ki-ledger-head .ki-co .ki-sub{font-size:8px;color:var(--ki-muted);}
  #ki-print-root .ki-ledger-head .ki-meta{margin-left:auto;text-align:right;font-size:7.5px;color:var(--ki-muted);}
  #ki-print-root .ki-ledger-head .ki-meta .ki-addr{max-width:320px;}

  #ki-print-root .ki-info-strip{display:grid;grid-template-columns:1fr 1fr;gap:0 12px;padding:4px 6px;font-size:9px;}
  #ki-print-root .ki-info-strip .ki-row{display:flex;justify-content:space-between;padding:1px 0;border-bottom:1px dotted var(--ki-line);}
  #ki-print-root .ki-info-strip .ki-row .ki-k{color:var(--ki-muted);}
  #ki-print-root .ki-info-strip .ki-row .ki-v{font-weight:700;}

  #ki-print-root .ki-schedule-strip{display:grid;grid-template-columns:repeat(4,1fr);gap:4px;padding:3px 6px;}
  #ki-print-root .ki-schedule-strip .ki-item{padding:2px 5px;border:1px solid var(--ki-black);border-radius:5px;}
  #ki-print-root .ki-schedule-strip .ki-item .ki-k{font-size:6.5px;color:var(--ki-muted);}
  #ki-print-root .ki-schedule-strip .ki-item .ki-v{font-size:8.5px;font-weight:700;margin-top:1px;}

  #ki-print-root .ki-ledger-scroll{padding:0 6px;}
  #ki-print-root table.ki-ledger{width:100%;min-width:0;border-collapse:collapse;font-size:7.8px;}
  #ki-print-root table.ki-ledger th{background:var(--ki-black);color:#fff;font-size:6.8px;font-weight:700;text-align:center;padding:2px 2px;border:1px solid var(--ki-black);}
  #ki-print-root table.ki-ledger td{padding:2px 2px;border:1px solid var(--ki-line);text-align:center;}
  #ki-print-root table.ki-ledger td.ki-name-cell{text-align:left;}
  #ki-print-root table.ki-ledger tr.ki-course-row{background:var(--ki-gold-soft);font-weight:700;}
  #ki-print-root table.ki-ledger td.ki-total-cell{font-weight:700;}

  #ki-print-root .ki-totals-strip{display:flex;justify-content:space-between;align-items:center;padding:4px 6px;border-top:2px solid var(--ki-black);}
  #ki-print-root .ki-totals-strip .ki-words{font-size:7.8px;color:var(--ki-muted);max-width:56%;}
  #ki-print-root .ki-totals-strip .ki-words b{color:var(--ki-ink);}
  #ki-print-root .ki-totals-strip .ki-grand{text-align:right;background:var(--ki-gold);border-radius:6px;padding:3px 10px;}
  #ki-print-root .ki-totals-strip .ki-grand .ki-lbl{font-size:7.8px;color:var(--ki-black);font-weight:600;}
  #ki-print-root .ki-totals-strip .ki-grand .ki-amt{font-size:13px;color:var(--ki-black);font-family:'Archivo Black',sans-serif;font-weight:400;}

  #ki-print-root .ki-note-strip{font-size:6.2px;color:var(--ki-muted);line-height:1.3;padding:3px 6px 4px;border-top:1px solid var(--ki-line);}
  #ki-print-root .ki-sign-strip{display:flex;justify-content:space-between;padding:6px 6px 3px;font-size:7.8px;color:var(--ki-muted);}
  #ki-print-root .ki-sign-strip .ki-line{border-top:1px solid var(--ki-black);padding-top:5px;width:140px;text-align:center;}
}
`;
