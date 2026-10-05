// Account 1130 (by account number) and every sub-account under it, at any depth.
const accts = ($input.first().json.QueryResponse || {}).Account || [];
const byId = {};
accts.forEach(a => { byId[a.Id] = a; });
const root = accts.find(a => a.AcctNum === '1130');
if (!root) throw new Error('No QuickBooks account with account number 1130.');
const inTree = a => { for (let x = a; x; x = x.ParentRef ? byId[x.ParentRef.value] : null) if (x.Id === root.Id) return true; return false; };
const tree = accts.filter(inTree).map(a => ({
  id: a.Id, num: a.AcctNum || '', name: a.FullyQualifiedName, short: a.Name, active: a.Active,
}));
tree.sort((a, b) => (a.id === root.Id ? -1 : b.id === root.Id ? 1 : a.name.localeCompare(b.name)));
return [{ json: { rootId: root.Id, rootName: root.FullyQualifiedName, ids: tree.map(t => t.id).join(','), tree } }];
