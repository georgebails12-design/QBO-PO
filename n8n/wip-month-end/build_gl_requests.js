// One GeneralLedger request per WIP account, inception to month end (read-only).
const P = $('Set Period').first().json;
const ACCTS = [
  ['1115', 'Inventory Asset:Work in Process'],
  ['1150040007', 'Inventory Asset:Work in Process:WIP Aluminum'],
  ['1150040008', 'Inventory Asset:Work in Process:WIP Glass'],
  ['1150040009', 'Inventory Asset:Work in Process:WIP Hardware'],
  ['1150040011', 'Inventory Asset:Work in Process:WIP Powder Coat'],
  ['1150040012', 'Inventory Asset:Work in Process:WIP Wood'],
];
const cols = 'tx_date,txn_type,doc_num,name,memo,split_acc,subt_nat_amount';
return ACCTS.map(([id, name]) => ({ json: { id, name,
  url: 'https://quickbooks.api.intuit.com/v3/company/9341454547526446/reports/GeneralLedger?start_date=2015-01-01&end_date=' + P.end +
    '&account=' + id + '&accounting_method=Accrual&columns=' + cols + '&minorversion=75' } }));
