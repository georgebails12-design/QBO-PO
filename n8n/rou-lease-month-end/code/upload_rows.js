// Approved: the validated rows, one item each, for the ROU Lease Register insert.
return $('Validate Upload').first().json.rows.map(r => ({ json: r }));
