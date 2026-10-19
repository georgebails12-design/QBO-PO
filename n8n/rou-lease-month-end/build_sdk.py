"""Writes workflow.sdk.ts from the Code-node scripts in code/.

    python3 n8n/rou-lease-month-end/build_sdk.py

Edit the scripts in code/, re-run this, then paste workflow.sdk.ts into n8n's
validate / update tools (or edit the Code nodes in n8n directly and copy them back).
"""
from pathlib import Path

HERE = Path(__file__).parent
QBO = "https://quickbooks.api.intuit.com/v3/company/9341454547526446"
REGISTER = ("sek8aEvAaYqqtY9W", "ROU Lease Register")
CLOSE_LOG = ("XkTCF4NnKqotzXNP", "ROU Monthly Close Log")


def js(name):
    src = (HERE / "code" / name).read_text()
    # Scripts are kept free of backslashes, backticks and ${ so they embed verbatim.
    assert not any(c in src for c in ("\\", "`", "${")), name
    return "`" + src + "`"


def code_node(var, name, script, pos, output):
    return f"""const {var} = node({{
  type: 'n8n-nodes-base.code', version: 2,
  config: {{ name: '{name}', position: {pos}, parameters: {{ mode: 'runOnceForAllItems', language: 'javaScript', jsCode: {js(script)} }} }},
  output: [{output}]
}});
"""


def qbo_get(var, name, path, params, pos):
    qp = ", ".join(f"{{ name: '{k}', value: {v} }}" for k, v in params)
    return f"""const {var} = node({{
  type: 'n8n-nodes-base.httpRequest', version: 4.2,
  config: {{
    name: '{name}', position: {pos}, executeOnce: true,
    parameters: {{
      url: '{QBO}/{path}', authentication: 'predefinedCredentialType', nodeCredentialType: 'quickBooksOAuth2Api',
      sendQuery: true, queryParameters: {{ parameters: [{qp}, {{ name: 'minorversion', value: '75' }}] }},
      sendHeaders: true, headerParameters: {{ parameters: [{{ name: 'Accept', value: 'application/json' }}] }}, options: {{ timeout: 60000 }}
    }},
    credentials: {{ quickBooksOAuth2Api: {{ id: 'sFWFYsCNN6o8AYZG', name: 'QuickBooks Online account' }} }}
  }},
  output: [{{ Rows: {{ Row: [] }} }}]
}});
"""


def if_true(var, name, left, pos):
    return f"""const {var} = ifElse({{
  version: 2.2,
  config: {{ name: '{name}', position: {pos}, parameters: {{ conditions: {{
    options: {{ caseSensitive: true, leftValue: '', typeValidation: 'loose' }},
    conditions: [{{ leftValue: expr("{left}"), operator: {{ type: 'boolean', operation: 'true', singleValue: true }} }}],
    combinator: 'and' }} }} }}
}});
"""


P = "$('Set Period').first().json"
parts = ["import { workflow, node, trigger, ifElse, sticky, expr } from '@n8n/workflow-sdk';\n"]
parts.append("""const runNow = trigger({ type: 'n8n-nodes-base.manualTrigger', version: 1, config: { name: 'Run Now', position: [0, 0] }, output: [{}] });

const monthly = trigger({
  type: 'n8n-nodes-base.scheduleTrigger', version: 1.4,
  config: { name: '5th of Month 7am', position: [0, 200], parameters: { rule: { interval: [{ field: 'months', monthsInterval: 1, triggerAtDayOfMonth: 5, triggerAtHour: 7, triggerAtMinute: 0 }] } } },
  output: [{}]
});

const calledByUpload = trigger({
  type: 'n8n-nodes-base.executeWorkflowTrigger', version: 1.2,
  config: { name: 'Called by Register Upload', position: [0, 400], parameters: { inputSource: 'workflowInputs', workflowInputs: { values: [{ name: 'month', type: 'string' }] } } },
  output: [{ month: '2026-09' }]
});
""")
parts.append(code_node("setPeriod", "Set Period", "set_period.js", "[240, 100]",
                       "{ period: '2026-09', start: '2026-09-01', end: '2026-09-30', label: 'Sep 2026', docNumber: 'ROU-202609', sendForApproval: true, approver: 'George@Panda-Windows.com', approvalDays: 14, accounts: {}, runAt: '2026-10-05 07:00' }"))
parts.append(f"""const getRegister = node({{
  type: 'n8n-nodes-base.dataTable', version: 1.1,
  config: {{
    name: 'Get Lease Register', position: [480, 100], executeOnce: true,
    parameters: {{ resource: 'row', operation: 'get', dataTableId: {{ __rl: true, mode: 'id', value: '{REGISTER[0]}', cachedResultName: '{REGISTER[1]}' }}, returnAll: true }}
  }},
  output: [{{ lease_id: 'ENTD', lease_name: 'ENTD LLC (Panda 2)', segment: 1, status: 'active' }}]
}});
""")
parts.append(qbo_get("getTb", "Get Trial Balance", "reports/TrialBalance", [
    ("start_date", f"expr(\"{{{{ {P}.start }}}}\")"), ("end_date", f"expr(\"{{{{ {P}.end }}}}\")"),
    ("accounting_method", "'Accrual'")], "[720, 100]"))
parts.append(qbo_get("getGl", "Get Rent GL", "reports/GeneralLedger", [
    ("account", "expr(\"{{ [...new Set($('Get Lease Register').all().flatMap(i => String((i.json.rent_account_id || '') + ',' + (i.json.cash_account_ids || '')).split(',')).map(s => s.trim()).filter(Boolean))].join(',') }}\")"),
    ("start_date", f"expr(\"{{{{ {P}.start }}}}\")"), ("end_date", f"expr(\"{{{{ {P}.end }}}}\")"),
    ("accounting_method", "'Accrual'"),
    ("columns", "'tx_date,txn_type,doc_num,name,memo,split_acc,subt_nat_amount'")], "[960, 100]"))
JE_QUERY = f"expr(\"{{{{ `select * from JournalEntry where TxnDate = '${{{P}.end}}' MAXRESULTS 1000` }}}}\")"
parts.append(qbo_get("findJe", "Find Existing ROU JE", "query", [("query", JE_QUERY)], "[1200, 100]"))
parts.append(code_node("buildProposal", "Build Proposal", "build_proposal.js", "[1440, 100]",
                       "{ period: '2026-09', label: 'Sep 2026', docNumber: 'ROU-202609', needsApproval: true, canPost: true, subject: 'ROU leases Sep 2026', html: '<p></p>', debits: 0, issues: [], flags: [], qbo: {}, payload: {} }"))
parts.append(code_node("buildWorkbook", "Build Workbook", "build_workbook.js", "[1680, 100]", "{ fileName: 'ROU_Rollforward_2026-09.xlsx', bytes: 0, sheets: [] }"))
parts.append(f"""const emailWorkbook = node({{
  type: 'n8n-nodes-base.microsoftOutlook', version: 2,
  config: {{
    name: 'Email Report and Workbook', position: [1920, 100], onError: 'continueRegularOutput',
    parameters: {{ resource: 'message', operation: 'send', toRecipients: expr("{{{{ {P}.approver }}}}"),
      subject: expr("{{{{ $('Build Proposal').first().json.subject }}}}"), bodyContent: expr("{{{{ $('Build Proposal').first().json.html }}}}"),
      additionalFields: {{ bodyContentType: 'html', attachments: {{ attachments: [{{ binaryPropertyName: 'workbook' }}] }} }} }},
    credentials: {{ microsoftOutlookOAuth2Api: {{ id: 'MLhN5eoDaYrrb4sO', name: 'Microsoft Outlook account' }} }}
  }},
  output: [{{ success: true }}]
}});
""")
parts.append(if_true("ifSend", "Send For Approval?", "{{ $('Build Proposal').first().json.needsApproval }}", "[2160, 100]"))
parts.append(f"""const askApproval = node({{
  type: 'n8n-nodes-base.microsoftOutlook', version: 2,
  config: {{
    name: 'Email for Approval', position: [2400, 0],
    parameters: {{
      resource: 'message', operation: 'sendAndWait',
      toRecipients: expr("{{{{ {P}.approver }}}}"),
      subject: expr("{{{{ 'Approve: ' + $('Build Proposal').first().json.subject }}}}"),
      message: expr("{{{{ $('Build Proposal').first().json.approvalHtml }}}}"),
      responseType: 'approval',
      approvalOptions: {{ values: {{ approvalType: 'double', approveLabel: 'Approve and post', buttonApprovalStyle: 'primary', disapproveLabel: 'Decline', buttonDisapprovalStyle: 'secondary' }} }},
      options: {{ limitWaitTime: {{ values: {{ limitType: 'afterTimeInterval', resumeAmount: expr("{{{{ {P}.approvalDays }}}}"), resumeUnit: 'days' }} }}, appendAttribution: false }}
    }},
    credentials: {{ microsoftOutlookOAuth2Api: {{ id: 'MLhN5eoDaYrrb4sO', name: 'Microsoft Outlook account' }} }}
  }},
  output: [{{ data: {{ approved: true }} }}]
}});
""")
parts.append(if_true("ifApproved", "Approved?", "{{ $json.data?.approved === true }}", "[2640, 0]"))
parts.append(qbo_get("recheckJe", "Recheck Existing ROU JE", "query", [("query", JE_QUERY)], "[2880, -100]"))
parts.append(qbo_get("recheckTb", "Recheck Balances", "reports/TrialBalance", [
    ("start_date", f"expr(\"{{{{ {P}.start }}}}\")"), ("end_date", f"expr(\"{{{{ {P}.end }}}}\")"),
    ("accounting_method", "'Accrual'")], "[3120, -100]"))
parts.append(code_node("guard", "Guard Before Posting", "guard_post.js", "[3360, -100]", "{ clear: true, payload: {} }"))
parts.append(if_true("ifClear", "Clear To Post?", "{{ $json.clear }}", "[3600, -100]"))
parts.append(f"""const postJe = node({{
  type: 'n8n-nodes-base.httpRequest', version: 4.2,
  config: {{
    name: 'Post Journal Entry', position: [3840, -200], onError: 'continueRegularOutput',
    parameters: {{
      method: 'POST', url: '{QBO}/journalentry', authentication: 'predefinedCredentialType', nodeCredentialType: 'quickBooksOAuth2Api',
      sendQuery: true, queryParameters: {{ parameters: [{{ name: 'minorversion', value: '75' }}] }},
      sendHeaders: true, headerParameters: {{ parameters: [{{ name: 'Accept', value: 'application/json' }}] }},
      sendBody: true, contentType: 'json', specifyBody: 'json', jsonBody: expr('{{{{ JSON.stringify($json.payload) }}}}'),
      options: {{ timeout: 60000, response: {{ response: {{ neverError: true }} }} }}
    }},
    credentials: {{ quickBooksOAuth2Api: {{ id: 'sFWFYsCNN6o8AYZG', name: 'QuickBooks Online account' }} }}
  }},
  output: [{{ JournalEntry: {{ Id: '1' }} }}]
}});
""")
parts.append(code_node("posted", "Posted Result", "posted_result.js", "[4080, -200]", "{ subject: '', html: '', log: {} }"))
parts.append(code_node("notApproved", "Not Approved", "not_approved.js", "[2880, 150]", "{ subject: '', html: '', log: {} }"))
parts.append(code_node("reportOnly", "Report Only", "report_only.js", "[2400, 300]", "{ subject: '', html: '', log: {} }"))
parts.append("""const finish = node({
  type: 'n8n-nodes-base.noOp', version: 1,
  config: { name: 'Outcome', position: [4320, 0] },
  output: [{ subject: '', html: '', log: {} }]
});
""")
parts.append(f"""const emailResult = node({{
  type: 'n8n-nodes-base.microsoftOutlook', version: 2,
  config: {{
    name: 'Email Result', position: [4560, -100],
    parameters: {{ resource: 'message', operation: 'send', toRecipients: expr("{{{{ {P}.approver }}}}"), subject: expr('{{{{ $json.subject }}}}'),
      bodyContent: expr('{{{{ $json.html }}}}'), additionalFields: {{ bodyContentType: 'html' }} }},
    credentials: {{ microsoftOutlookOAuth2Api: {{ id: 'MLhN5eoDaYrrb4sO', name: 'Microsoft Outlook account' }} }}
  }},
  output: [{{ id: 'AAMk' }}]
}});
""")
parts.append(code_node("logRow", "Log Row", "log_row.js", "[4560, 200]", "{ period: '2026-09', doc_number: 'ROU-202609', status: 'posted' }"))
parts.append(f"""const saveLog = node({{
  type: 'n8n-nodes-base.dataTable', version: 1.1,
  config: {{
    name: 'Save Close Log', position: [4800, 200],
    parameters: {{ resource: 'row', operation: 'insert', dataTableId: {{ __rl: true, mode: 'id', value: '{CLOSE_LOG[0]}', cachedResultName: '{CLOSE_LOG[1]}' }},
      columns: {{ mappingMode: 'autoMapInputData', value: null }}, options: {{}} }}
  }},
  output: [{{ id: 1 }}]
}});
""")
note = ("## ROU lease month-end (ASC 842)\\n"
        "Runs on the 5th for last month (or **Run Now**; set `MONTH_OVERRIDE` in **Set Period** to redo a month).\\n"
        "1. Builds every lease schedule from the **ROU Lease Register** data table.\\n"
        "2. Reads QuickBooks: month-end Trial Balance (2000 / 2001 / 2320 / 2600), rent posted per lease, ROU entries already posted.\\n"
        "3. Proposes JE **ROU-YYYYMM** that brings QuickBooks to the schedule; emails the report + **ROU_Rollforward_YYYY-MM.xlsx**, then a second email with **Approve and post / Decline**.\\n"
        "4. On approve: re-checks nothing changed, posts, emails the result and logs it in **ROU Monthly Close Log**.\\n"
        "Lease changes: edit the Register sheet of the workbook and upload it on the **ROU Lease Register Upload** form (or edit the data table), then re-run the month.\\n"
        "Source: QBO-PO repo, n8n/rou-lease-month-end/.")
parts.append(f"const note = sticky('{note}', [setPeriod, getRegister, getTb, getGl, findJe, buildProposal], {{ color: 4 }});\n")
parts.append("""
export default workflow('rou-lease-month-end', 'QBO - ROU Lease Month-End JE (approval by email)')
  .add(runNow)
  .to(setPeriod)
  .add(monthly)
  .to(setPeriod)
  .add(calledByUpload)
  .to(setPeriod)
  .to(getRegister)
  .to(getTb)
  .to(getGl)
  .to(findJe)
  .to(buildProposal)
  .to(buildWorkbook)
  .to(emailWorkbook)
  .to(ifSend
    .onTrue(askApproval.to(ifApproved
      .onTrue(recheckJe.to(recheckTb.to(guard.to(ifClear
        .onTrue(postJe.to(posted.to(finish)))
        .onFalse(finish)))))
      .onFalse(notApproved.to(finish))))
    .onFalse(reportOnly.to(logRow)))
  .add(finish)
  .to(emailResult)
  .add(finish)
  .to(logRow)
  .add(logRow)
  .to(saveLog)
  .add(note);
""")
(HERE / "workflow.sdk.ts").write_text("\n".join(parts))
print("wrote", HERE / "workflow.sdk.ts")

# ---------------------------------------------------------------- upload workflow
MAIN_ID = "CVnWIZUBMEfeXmpV"
APPROVER = "George@Panda-Windows.com"
u = ["import { workflow, node, trigger, ifElse, sticky, expr } from '@n8n/workflow-sdk';\n"]
u.append("""const uploadForm = trigger({
  type: 'n8n-nodes-base.formTrigger', version: 2.6,
  config: {
    name: 'Upload Form', position: [0, 100],
    parameters: {
      formTitle: 'ROU Lease Register Upload',
      formDescription: 'Upload the ROU_Rollforward workbook after editing its <b>Register</b> sheet (new lease, renewal / amendment, rate, status). The changes are emailed for approval before anything is saved.',
      formFields: { values: [
        { fieldName: 'workbook', fieldLabel: 'ROU workbook (.xlsx with a Register sheet)', fieldType: 'file', multipleFiles: false, acceptFileTypes: '.xlsx', requiredField: true },
        { fieldName: 'rerun_month', fieldLabel: 'After approval, re-run the ROU month-end for (YYYY-MM, optional)', fieldType: 'text', placeholder: '2026-09' },
        { fieldName: 'note', fieldLabel: 'What changed (shown in the approval email)', fieldType: 'textarea' }
      ] },
      responseMode: 'onReceived',
      options: { appendAttribution: false, path: 'rou-lease-register-upload', buttonLabel: 'Upload',
        respondWithOptions: { values: { respondWith: 'text', formSubmittedText: 'Received. The changes (or any errors) will be emailed for approval; nothing is saved until they are approved.' } } }
    }
  },
  output: [{ rerun_month: '', note: '' }]
});

const extract = node({
  type: 'n8n-nodes-base.extractFromFile', version: 1.1,
  config: {
    name: 'Extract Register Sheet', position: [240, 100], onError: 'continueRegularOutput', alwaysOutputData: true,
    parameters: { operation: 'xlsx', binaryPropertyName: expr('{{ Object.keys($binary || {})[0] || "workbook" }}'),
      options: { sheetName: 'Register', headerRow: true, rawData: true } }
  },
  output: [{ lease_id: 'ENTD', segment: 1, status: 'active' }]
});
""")
u.append(f"""const getCurrent = node({{
  type: 'n8n-nodes-base.dataTable', version: 1.1,
  config: {{
    name: 'Get Current Register', position: [480, 100], executeOnce: true, alwaysOutputData: true,
    parameters: {{ resource: 'row', operation: 'get', dataTableId: {{ __rl: true, mode: 'id', value: '{REGISTER[0]}', cachedResultName: '{REGISTER[1]}' }}, returnAll: true }}
  }},
  output: [{{ lease_id: 'ENTD', segment: 1 }}]
}});
""")
u.append(code_node("validate", "Validate Upload", "upload_validate.js", "[720, 100]", "{ valid: true, needsApproval: true, rows: [], changes: [], rerunMonth: '', subject: '', html: '' }"))
u.append(if_true("ifNeeds", "Changes To Approve?", "{{ $json.needsApproval }}", "[960, 100]"))
u.append(f"""const askChanges = node({{
  type: 'n8n-nodes-base.microsoftOutlook', version: 2,
  config: {{
    name: 'Email Changes for Approval', position: [1200, 0],
    parameters: {{
      resource: 'message', operation: 'sendAndWait', toRecipients: '{APPROVER}',
      subject: expr('{{{{ $json.subject }}}}'), message: expr('{{{{ $json.html }}}}'), responseType: 'approval',
      approvalOptions: {{ values: {{ approvalType: 'double', approveLabel: 'Approve and update register', buttonApprovalStyle: 'primary', disapproveLabel: 'Decline', buttonDisapprovalStyle: 'secondary' }} }},
      options: {{ limitWaitTime: {{ values: {{ limitType: 'afterTimeInterval', resumeAmount: 7, resumeUnit: 'days' }} }}, appendAttribution: false }}
    }},
    credentials: {{ microsoftOutlookOAuth2Api: {{ id: 'MLhN5eoDaYrrb4sO', name: 'Microsoft Outlook account' }} }}
  }},
  output: [{{ data: {{ approved: true }} }}]
}});
""")
u.append(if_true("ifOk", "Approved?", "{{ $json.data?.approved === true }}", "[1440, 0]"))
u.append(f"""const clearRegister = node({{
  type: 'n8n-nodes-base.dataTable', version: 1.1,
  config: {{
    name: 'Clear Register', position: [1680, -100], executeOnce: true, alwaysOutputData: true,
    parameters: {{ resource: 'row', operation: 'deleteRows', dataTableId: {{ __rl: true, mode: 'id', value: '{REGISTER[0]}', cachedResultName: '{REGISTER[1]}' }},
      matchType: 'anyCondition', filters: {{ conditions: [{{ keyName: 'id', condition: 'gte', keyValue: '0' }}] }}, options: {{}} }}
  }},
  output: [{{ id: 1 }}]
}});
""")
u.append(code_node("newRows", "Register Rows", "upload_rows.js", "[1920, -100]", "{ lease_id: 'ENTD', segment: 1 }"))
u.append(f"""const insertRows = node({{
  type: 'n8n-nodes-base.dataTable', version: 1.1,
  config: {{
    name: 'Insert Register Rows', position: [2160, -100],
    parameters: {{ resource: 'row', operation: 'insert', dataTableId: {{ __rl: true, mode: 'id', value: '{REGISTER[0]}', cachedResultName: '{REGISTER[1]}' }},
      columns: {{ mappingMode: 'autoMapInputData', value: null }}, options: {{}} }}
  }},
  output: [{{ id: 1 }}]
}});
""")
u.append(code_node("result", "Upload Result", "upload_result.js", "[2400, 100]", "{ status: 'loaded', rerun: false, month: '', subject: '', html: '' }"))
u.append(f"""const emailUpload = node({{
  type: 'n8n-nodes-base.microsoftOutlook', version: 2,
  config: {{
    name: 'Email Upload Result', position: [2640, 0],
    parameters: {{ resource: 'message', operation: 'send', toRecipients: '{APPROVER}', subject: expr('{{{{ $json.subject }}}}'),
      bodyContent: expr('{{{{ $json.html }}}}'), additionalFields: {{ bodyContentType: 'html' }} }},
    credentials: {{ microsoftOutlookOAuth2Api: {{ id: 'MLhN5eoDaYrrb4sO', name: 'Microsoft Outlook account' }} }}
  }},
  output: [{{ success: true }}]
}});
""")
u.append(if_true("ifRerun", "Re-run Month?", "{{ $json.rerun }}", "[2640, 200]"))
u.append(f"""const runMonth = node({{
  type: 'n8n-nodes-base.executeWorkflow', version: 1.3,
  config: {{
    name: 'Run ROU Month-End', position: [2880, 200],
    parameters: {{
      mode: 'once', source: 'database',
      workflowId: {{ __rl: true, mode: 'id', value: '{MAIN_ID}', cachedResultName: 'QBO - ROU Lease Month-End JE (approval by email)' }},
      workflowInputs: {{ mappingMode: 'defineBelow', value: {{ month: expr('{{{{ $json.month }}}}') }}, matchingColumns: [],
        schema: [{{ id: 'month', displayName: 'month', required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'string' }}],
        attemptToConvertTypes: false, convertFieldsToString: true }},
      options: {{ waitForSubWorkflow: false }}
    }}
  }},
  output: [{{}}]
}});
""")
unote = ("## ROU Lease Register upload\\n"
         "Form: upload the ROU_Rollforward workbook after editing its **Register** sheet.\\n"
         "1. Reads the Register sheet and checks every row (months, status, rate, payments, duplicates). A new active lease with no opening balance gets the PV of its payments.\\n"
         "2. Emails the list of changes with **Approve and update register / Decline** (errors are emailed instead).\\n"
         "3. Approve: replaces the **ROU Lease Register** data table and, if a month was entered, runs the ROU month-end for it.\\n"
         "Source: QBO-PO repo, n8n/rou-lease-month-end/ (upload_*.js).")
u.append(f"const unote = sticky('{unote}', [extract, getCurrent, validate], {{ color: 4 }});\n")
u.append("""
export default workflow('rou-lease-register-upload', 'QBO - ROU Lease Register Upload (approval by email)')
  .add(uploadForm)
  .to(extract)
  .to(getCurrent)
  .to(validate)
  .to(ifNeeds
    .onTrue(askChanges.to(ifOk
      .onTrue(clearRegister.to(newRows.to(insertRows.to(result))))
      .onFalse(result)))
    .onFalse(result))
  .add(result)
  .to(emailUpload)
  .add(result)
  .to(ifRerun.onTrue(runMonth))
  .add(unote);
""")
(HERE / "workflow_upload.sdk.ts").write_text("\n".join(u))
print("wrote", HERE / "workflow_upload.sdk.ts")
