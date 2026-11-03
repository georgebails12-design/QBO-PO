# Assembles workflow.js (n8n Workflow SDK code) from the Code-node sources in this folder.
import json, os
D = os.path.dirname(os.path.abspath(__file__))
js = lambda f: json.dumps(open(os.path.join(D, f)).read())
QBO = "{ quickBooksOAuth2Api: { id: 'sFWFYsCNN6o8AYZG', name: 'QuickBooks Online account' } }"
WASP = "{ httpBearerAuth: { id: '7awrSdjW2myNV459', name: 'WASP API Token' } }"
OUT = "{ microsoftOutlookOAuth2Api: { id: 'MLhN5eoDaYrrb4sO', name: 'Microsoft Outlook account' } }"
QURL = "https://quickbooks.api.intuit.com/v3/company/9341454547526446"
code = lambda var, name, f, extra='': f"""const {var} = node({{ type: 'n8n-nodes-base.code', version: 2, config: {{ name: '{name}', {extra} parameters: {{ mode: 'runOnceForAllItems', language: 'javaScript', jsCode: {js(f)} }} }} }});"""
inline = lambda var, name, src, extra='': f"""const {var} = node({{ type: 'n8n-nodes-base.code', version: 2, config: {{ name: '{name}', {extra} parameters: {{ mode: 'runOnceForAllItems', language: 'javaScript', jsCode: {json.dumps(src)} }} }} }});"""
def qbo_get(var, name, url, query, extra='executeOnce: true,', opts="{ timeout: 120000 }"):
    q = ', '.join("{ name: %s, value: %s }" % (json.dumps(k), json.dumps(v)) for k, v in query)
    return f"""const {var} = node({{ type: 'n8n-nodes-base.httpRequest', version: 4.2, config: {{ name: '{name}', {extra} retryOnFail: true, maxTries: 3, waitBetweenTries: 5000,
  parameters: {{ url: {json.dumps(url)}, authentication: 'predefinedCredentialType', nodeCredentialType: 'quickBooksOAuth2Api', sendQuery: true,
    queryParameters: {{ parameters: [{q}] }}, sendHeaders: true, headerParameters: {{ parameters: [{{ name: 'Accept', value: 'application/json' }}] }}, options: {opts} }},
  credentials: {QBO} }} }});"""
def dt_get(var, name, tid, tname, filters=None, extra='executeOnce: true,'):
    f = ''
    if filters:
        f = ", matchType: 'allConditions', filters: { conditions: [" + ', '.join(filters) + "] }"
    return f"""const {var} = node({{ type: 'n8n-nodes-base.dataTable', version: 1.1, config: {{ name: '{name}', {extra}
  parameters: {{ resource: 'row', operation: 'get', dataTableId: {{ __rl: true, mode: 'id', value: '{tid}', cachedResultName: '{tname}' }}, returnAll: true{f} }} }} }});"""
def dt_insert(var, name, tid, tname):
    return f"""const {var} = node({{ type: 'n8n-nodes-base.dataTable', version: 1.1, config: {{ name: '{name}',
  parameters: {{ resource: 'row', operation: 'insert', dataTableId: {{ __rl: true, mode: 'id', value: '{tid}', cachedResultName: '{tname}' }}, columns: {{ mappingMode: 'autoMapInputData', value: null }}, options: {{}} }} }} }});"""
def iff(var, name, expr):
    return f"""const {var} = ifElse({{ version: 2.2, config: {{ name: '{name}', parameters: {{ conditions: {{ options: {{ caseSensitive: true, leftValue: '', typeValidation: 'loose' }},
  conditions: [{{ leftValue: {json.dumps(expr)}, operator: {{ type: 'boolean', operation: 'true', singleValue: true }} }}], combinator: 'and' }}, options: {{}} }} }} }});"""
def wasp_csv(var, name):
    return f"""const {var} = node({{ type: 'n8n-nodes-base.httpRequest', version: 4.2, config: {{ name: '{name}', executeOnce: true, retryOnFail: true, maxTries: 3, waitBetweenTries: 5000,
  parameters: {{ method: 'POST', url: 'https://pandawd.waspinventorycloud.com/public-api/ic/item/streamgridrequestcsvflat', authentication: 'genericCredentialType', genericAuthType: 'httpBearerAuth',
    sendBody: true, contentType: 'json', specifyBody: 'json', jsonBody: '{{}}',
    options: {{ allowUnauthorizedCerts: true, timeout: 300000, response: {{ response: {{ responseFormat: 'text', outputPropertyName: 'data' }} }} }} }},
  credentials: {WASP} }} }});"""

je_q = "={{ \"select * from JournalEntry where TxnDate >= '\" + $('Set Period').first().json.jeStart + \"' and TxnDate <= '\" + $('Set Period').first().json.end + \"' STARTPOSITION 1 MAXRESULTS 500\" }}"
je_q_page = "={{ \"select * from JournalEntry where TxnDate >= '\" + $('Set Period').first().json.jeStart + \"' and TxnDate <= '\" + $('Set Period').first().json.end + \"' STARTPOSITION \" + (1 + 500 * $pageCount) + \" MAXRESULTS 500\" }}"
exist_q = "={{ \"select * from JournalEntry where TxnDate = '\" + $('Set Period').first().json.end + \"' MAXRESULTS 1000\" }}"
tb_q = [('start_date', "={{ $('Set Period').first().json.start }}"), ('end_date', "={{ $('Set Period').first().json.end }}"), ('accounting_method', 'Accrual'), ('minorversion', '75')]

parts = []
A = parts.append
A("import { workflow, node, trigger, ifElse, sticky } from '@n8n/workflow-sdk';")
A("""const daily = trigger({ type: 'n8n-nodes-base.scheduleTrigger', version: 1.2, config: { name: 'Weekdays 5 PM PT', parameters: { rule: { interval: [{ field: 'cronExpression', expression: '0 17 * * 1-5' }] } } } });
const runNow = trigger({ type: 'n8n-nodes-base.manualTrigger', version: 1, config: { name: 'Run Now' } });
const nightly = trigger({ type: 'n8n-nodes-base.scheduleTrigger', version: 1.2, config: { name: 'Nightly 11:50 PM PT', parameters: { rule: { interval: [{ field: 'cronExpression', expression: '50 23 * * *' }] } } } });
const snapNow = trigger({ type: 'n8n-nodes-base.manualTrigger', version: 1, config: { name: 'Run Snapshot Now' } });""")
A(code('setPeriod', 'Set Period', 'set_period.js'))
A(code('buildGl', 'Build GL Requests', 'build_gl_requests.js'))
A(f"""const getGl = node({{ type: 'n8n-nodes-base.httpRequest', version: 4.2, config: {{ name: 'Get General Ledger', retryOnFail: true, maxTries: 3, waitBetweenTries: 5000,
  parameters: {{ url: '={{{{ $json.url }}}}', authentication: 'predefinedCredentialType', nodeCredentialType: 'quickBooksOAuth2Api', sendHeaders: true,
    headerParameters: {{ parameters: [{{ name: 'Accept', value: 'application/json' }}] }}, options: {{ timeout: 180000, batching: {{ batch: {{ batchSize: 1, batchInterval: 1000 }} }} }} }},
  credentials: {QBO} }} }});""")
A(qbo_get('getJes', 'Get WIP Journal Entries', QURL + '/query', [('query', je_q), ('minorversion', '75')],
  opts="{ timeout: 180000, pagination: { pagination: { paginationMode: 'updateAParameterInEachRequest', parameters: { parameters: [{ type: 'qs', name: 'query', value: %s }] }, paginationCompleteWhen: 'other', completeExpression: '={{ ((($response.body.QueryResponse || {}).JournalEntry) || []).length < 500 }}', limitPagesFetched: true, maxRequests: 40, requestInterval: 500 } } }" % json.dumps(je_q_page)))
A(dt_get('getPicks', 'Get Picks', '8Mpjo2TYqasSdChL', 'Daily Wasp Transactions',
  ["{ keyName: 'trans_type_description', keyValue: 'Pick' }", "{ keyName: 'asset_trans_date', condition: 'gte', keyValue: \"={{ DateTime.fromISO($('Set Period').first().json.jeStart).minus({ days: 400 }).toISO() }}\" }"]))
A(dt_get('getJobs', 'Get Shop Jobs', 'XhjKRsAyuNG6UYR3', 'Shop Jobs Date Completed'))
A(qbo_get('getTb', 'Get Trial Balance', QURL + '/reports/TrialBalance', tb_q))
A(dt_get('getSnap', 'Get WASP Snapshot', 'XHwQETgSO7XQ4xxp', 'WASP Month-End Inventory', ["{ keyName: 'month', keyValue: \"={{ $('Set Period').first().json.period }}\" }"], extra='executeOnce: true, alwaysOutputData: true,'))
A(wasp_csv('getInv', 'Get WASP Inventory'))
A(f"""const getAct = node({{ type: 'n8n-nodes-base.httpRequest', version: 4.2, config: {{ name: 'Get WASP Activity', executeOnce: true, retryOnFail: true, maxTries: 3, waitBetweenTries: 5000,
  parameters: {{ method: 'POST', url: 'https://pandawd.waspinventorycloud.com/public-api/transactions/grid-query/history-public-api', authentication: 'genericCredentialType', genericAuthType: 'httpBearerAuth',
    sendBody: true, contentType: 'json', specifyBody: 'json',
    jsonBody: "={{{{ JSON.stringify({{ PageSize: 500, PageNumber: 1, Sort: [{{ Field: 'TransactionDate', Dir: 'asc' }}], Filter: {{ filters: [{{ field: 'TransactionDate', operator: '>=', value: $('Set Period').first().json.nextDay + 'T00:00:00.000' }}] }}, ClientUtcOffset: 'Pacific Standard Time', FilterBehavior: 0 }}) }}}}",
    options: {{ allowUnauthorizedCerts: true, timeout: 120000, pagination: {{ pagination: {{ paginationMode: 'updateAParameterInEachRequest', parameters: {{ parameters: [{{ type: 'body', name: 'PageNumber', value: '={{{{ $pageCount + 1 }}}}' }}] }},
      paginationCompleteWhen: 'other', completeExpression: '={{{{ !Array.isArray($response.body.Data) || $response.body.Data.length < 500 }}}}', limitPagesFetched: true, maxRequests: 60, requestInterval: 700 }} }} }} }},
  credentials: {WASP} }} }});""")
A(qbo_get('findJes', 'Find Existing JEs', QURL + '/query', [('query', exist_q), ('minorversion', '75')]))
A(code('buildProp', 'Build Proposal', 'build_proposal.js'))
A(code('buildWb', 'Build Workbook', 'build_workbook.js'))
A(f"""const emailReport = node({{ type: 'n8n-nodes-base.microsoftOutlook', version: 2, config: {{ name: 'Email Report and Workbook',
  parameters: {{ resource: 'message', operation: 'send', toRecipients: "={{{{ $('Set Period').first().json.approver }}}}", subject: "={{{{ $('Build Proposal').first().json.subject }}}}",
    bodyContent: "={{{{ $('Build Proposal').first().json.html }}}}", additionalFields: {{ bodyContentType: 'html', attachments: {{ attachments: [{{ binaryPropertyName: 'workbook' }}] }} }} }},
  credentials: {OUT} }} }});""")
A(iff('sendForApproval', 'Send For Approval?', "={{ $('Build Proposal').first().json.needsApproval }}"))
A(f"""const emailApproval = node({{ type: 'n8n-nodes-base.microsoftOutlook', version: 2, config: {{ name: 'Email for Approval',
  parameters: {{ resource: 'message', operation: 'sendAndWait', toRecipients: "={{{{ $('Set Period').first().json.approver }}}}",
    subject: "={{{{ 'Approve: ' + $('Build Proposal').first().json.subject }}}}", message: "={{{{ $('Build Proposal').first().json.approvalHtml }}}}",
    responseType: 'approval', approvalOptions: {{ values: {{ approvalType: 'double', approveLabel: 'Approve and post', buttonApprovalStyle: 'primary', disapproveLabel: 'Decline', buttonDisapprovalStyle: 'secondary' }} }},
    options: {{ limitWaitTime: {{ values: {{ limitType: 'afterTimeInterval', resumeAmount: "={{{{ $('Set Period').first().json.approvalDays }}}}", resumeUnit: 'days' }} }}, appendAttribution: false }} }},
  credentials: {OUT} }} }});""")
A(iff('approved', 'Approved?', "={{ $json.data?.approved === true }}"))
A(qbo_get('recheckJes', 'Recheck Existing JEs', QURL + '/query', [('query', exist_q), ('minorversion', '75')]))
A(qbo_get('recheckTb', 'Recheck Balances', QURL + '/reports/TrialBalance', tb_q))
A(code('guard', 'Guard Before Posting', 'guard_before_posting.js'))
A(iff('clear', 'Clear To Post?', "={{ $json.clear }}"))
A(f"""const postJe = node({{ type: 'n8n-nodes-base.httpRequest', version: 4.2, config: {{ name: 'Post Journal Entry',
  parameters: {{ method: 'POST', url: '{QURL}/journalentry', authentication: 'predefinedCredentialType', nodeCredentialType: 'quickBooksOAuth2Api',
    sendQuery: true, queryParameters: {{ parameters: [{{ name: 'minorversion', value: '75' }}] }}, sendHeaders: true, headerParameters: {{ parameters: [{{ name: 'Accept', value: 'application/json' }}] }},
    sendBody: true, contentType: 'json', specifyBody: 'json', jsonBody: '={{{{ JSON.stringify($json.payload) }}}}',
    options: {{ timeout: 120000, batching: {{ batch: {{ batchSize: 1, batchInterval: 1000 }} }}, response: {{ response: {{ neverError: true }} }} }} }},
  credentials: {QBO} }} }});""")
A(code('postedResult', 'Posted Result', 'posted_result.js'))
A(code('notPosted', 'Not Posted', 'not_posted.js'))
A(code('reportOnly', 'Report Only', 'report_only.js'))
A("const outcome = node({ type: 'n8n-nodes-base.noOp', version: 1, config: { name: 'Outcome' } });")
A(f"""const emailResult = node({{ type: 'n8n-nodes-base.microsoftOutlook', version: 2, config: {{ name: 'Email Result',
  parameters: {{ resource: 'message', operation: 'send', toRecipients: "={{{{ $('Set Period').first().json.approver }}}}", subject: '={{{{ $json.subject }}}}',
    bodyContent: '={{{{ $json.html }}}}', additionalFields: {{ bodyContentType: 'html' }} }},
  credentials: {OUT} }} }});""")
A(inline('logRow', 'Log Row', "// One row per run for the WIP Month-End Close Log data table.\nreturn $input.all().map(i => ({ json: i.json.log }));"))
A(dt_insert('saveLog', 'Save Close Log', 'BwlCBmhQc4upu3jr', 'WIP Month-End Close Log'))
A(inline('movesRows', 'Moves Rows', "// Posted WIP -> COGS lines, recorded in WIP to COGS Moves (same table the Daily WIP to COGS\n// workflow uses), so nothing is moved twice.\nreturn $input.all().flatMap(i => (i.json.moves || []).map(m => ({ json: m })));"))
A(dt_insert('saveMoves', 'Save WIP to COGS Moves', 'llZwcCsPioI6VB1b', 'WIP to COGS Moves'))
A(code('snapDay', 'Snapshot Day', 'snapshot_day.js'))
A(wasp_csv('snapInv', 'Get WASP Inventory (snapshot)'))
A(code('snapRows', 'Build Snapshot Rows', 'build_snapshot_rows.js'))
A(dt_insert('saveSnap', 'Save Snapshot', 'XHwQETgSO7XQ4xxp', 'WASP Month-End Inventory'))
A("""const note = sticky('## WIP, COGS & inventory month-end\\nRuns **5 PM PT on the first business day** of the month for the prior month (weekday schedule; Set Period stops on other days). **Run Now** runs last month; set `MONTH_OVERRIDE` in **Set Period** to redo one.\\n1. Ties every line in the WIP sub-accounts to a Shop Updates job (WASP pick / QBO customer:project) and its status at month end.\\n2. Proposes **WIPCOGS-YYYY-MM** (Dr COGS / Cr WIP for jobs completed in the month); **WIPCOGS-PRIOR-YYYY-MM** for older completions if `INCLUDE_PRIOR_COMPLETIONS`.\\n3. Trues QuickBooks raw materials up to WASP at month end: **INVTRUEUP-YYYY-MM** (Raw Materials vs matching COGS / 5381 Shop Supplies). WASP month end = the **11:50 PM snapshot** taken on the last day (Save Snapshot -> WASP Month-End Inventory); without one, live WASP rolled back (estimate).\\n4. Emails the workbook (Summary, WIP, COGS, Inventory True-up, Inventory Detail, All Data), then Approve / Decline. Approve re-checks and posts; moves go to **WIP to COGS Moves**, runs to **WIP Month-End Close Log**.\\nThe parent account Inventory Asset:Work in Process (offset) is reported, never changed.\\nSource: QBO-PO repo, n8n/wip-month-end/.', { color: 4, position: [0, -420], width: 760, height: 380 });""")
A("""export default workflow('wip-cogs-inventory-month-end', 'QBO - WIP, COGS & Inventory Month-End (approval by email)')
  .add(daily).to(setPeriod)
  .add(runNow).to(setPeriod)
  .add(setPeriod).to(buildGl).to(getGl).to(getJes).to(getPicks).to(getJobs).to(getTb).to(getSnap).to(getInv).to(getAct).to(findJes).to(buildProp).to(buildWb).to(emailReport)
  .to(sendForApproval
    .onTrue(emailApproval.to(approved
      .onTrue(recheckJes.to(recheckTb).to(guard).to(clear
        .onTrue(postJe.to(postedResult).to(outcome))
        .onFalse(notPosted)))
      .onFalse(notPosted)))
    .onFalse(reportOnly.to(logRow)))
  .add(notPosted).to(outcome)
  .add(outcome).to(emailResult)
  .add(outcome).to(logRow)
  .add(outcome).to(movesRows).to(saveMoves)
  .add(logRow).to(saveLog)
  .add(nightly).to(snapDay)
  .add(snapNow).to(snapDay)
  .add(snapDay).to(snapInv).to(snapRows).to(saveSnap)
  .add(note);""")
open(os.path.join(D, 'workflow.js'), 'w').write('\n'.join(parts) + '\n')
print(len('\n'.join(parts)))
