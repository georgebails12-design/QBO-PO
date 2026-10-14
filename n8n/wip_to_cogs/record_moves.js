// Pair each Post Journal Entry response with its JE and turn the posted ones
// into WIP to COGS Moves rows (the record that stops a job moving twice).
const jes = $('Build Journal Entries').all().map(i => i.json);
const now = new Date().toISOString();
const out = [];
$input.all().forEach((i, idx) => {
  const id = i.json.JournalEntry && i.json.JournalEntry.Id;
  if (!id) return;
  for (const m of jes[idx].moves) out.push({ json: {
    job: m.job, shop_item_id: m.shop_item_id, job_type: m.job_type, date_completed: m.date_completed,
    wip_account: m.wip_account, wip_account_id: m.wip_account_id, cogs_account: m.cogs_account,
    cogs_account_id: m.cogs_account_id, amount: m.amount, customer_qbo_id: m.customer_qbo_id,
    customer_name: m.customer_name, picks: m.picks, txn_date: m.txn_date, je_doc: m.je_doc,
    qbo_je_id: String(id), posted_at: now,
  } });
});
return out;
