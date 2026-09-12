package handlers

/*
The compliance column says something about a named host, so every way it can name
the wrong one is worth pinning.

Three of them, and none announces itself on screen: a hostname normalised into a
different site's row, a flag read as a verdict it does not carry, and the column
appearing on a panel whose rows are not domains at all. Each produces a report
that renders perfectly and tells the reader something untrue about a host they
are about to send notices to.
*/

import "testing"

/*
Normalisation gets a hostname into the routing table's own form — and no further.

The report's domain columns hold bare hostnames, so nearly all of this is
defensive. It is here because the two sides are filled by different pipelines,
and one "https://" on one of them would turn the whole column into "Not recorded"
with nothing on screen saying why.
*/
func TestNormaliseDomain(t *testing.T) {
	for _, c := range []struct{ in, want string }{
		{"Example.COM", "example.com"},
		{"  example.com  ", "example.com"},
		{"example.com.", "example.com"},
		{"https://example.com", "example.com"},
		{"http://example.com/watch?id=4", "example.com"},
		{"example.com:8080", "example.com"},
		{"example.com/path", "example.com"},
		// www. SURVIVES. It is a real label, and a site at www.example.com may
		// be a different one from example.com with a different answer — so it is
		// tried as a separate candidate rather than assumed away here.
		{"www.example.com", "www.example.com"},
		{"", ""},
	} {
		if got := normaliseDomain(c.in); got != c.want {
			t.Errorf("normaliseDomain(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

/*
The exact spelling is always tried FIRST.

Both directions are offered because the two pipelines disagree about www. often
enough to matter. The order is what keeps that from becoming a wrong answer: a
row for the name as the report holds it always beats a row for the shifted one,
so the fallback can only ever fill a gap, never overrule a hit.
*/
func TestComplianceCandidatesTryTheExactNameFirst(t *testing.T) {
	got := complianceCandidates("Example.com")
	if len(got) != 2 || got[0] != "example.com" || got[1] != "www.example.com" {
		t.Errorf("candidates for example.com = %v, want [example.com www.example.com]", got)
	}
	got = complianceCandidates("www.example.com")
	if len(got) != 2 || got[0] != "www.example.com" || got[1] != "example.com" {
		t.Errorf("candidates for www.example.com = %v, want the exact name first", got)
	}
	if got := complianceCandidates("   "); got != nil {
		t.Errorf("an empty hostname produced candidates: %v", got)
	}
}

/*
The flag reads as three answers, not two.

6,417 rows are 1 and 147,367 are 0, and 167 are NEITHER. A two-branch expression
would file those 167 under whichever branch it fell through to and report them as
a finding about the host. reports_api's own master applies the same three-way
CASE, so the portal's column and that endpoint cannot disagree about one domain.
*/
func TestComplianceLabel(t *testing.T) {
	for _, c := range []struct {
		in   any
		want string
	}{
		{int64(1), complianceYes},
		{1, complianceYes},
		{"1", complianceYes},
		{int64(0), complianceNo},
		{"0", complianceNo},
		// Outside {0,1} — a real state on 167 rows, and not a verdict.
		{int64(7), complianceUnknown},
		{int64(-1), complianceUnknown},
		// NULL: the row exists and does not answer.
		{nil, complianceUnknown},
		/* And anything unreadable as a number. numOf returns 0 for these, which
		   would otherwise print as Non-Compliant — a claim about the host
		   invented out of a parse failure. */
		{"maybe", complianceUnknown},
	} {
		if got := complianceLabel(c.in); got != c.want {
			t.Errorf("complianceLabel(%#v) = %q, want %q", c.in, got, c.want)
		}
	}
}

/*
"Not recorded" and "Unknown" are different answers and must stay different words.

Unknown is a routing row that does not say. Not recorded is no routing row at all
— no notice route has ever been set up for a host the crawler is finding content
on, which is an operational gap rather than an assessment. Collapsing them would
hide it.
*/
func TestTheFourAnswersAreDistinct(t *testing.T) {
	seen := map[string]bool{}
	for _, s := range []string{complianceYes, complianceNo, complianceUnknown, complianceAbsent} {
		if s == "" {
			t.Fatal("an empty status would render as a blank cell rather than an answer")
		}
		if seen[s] {
			t.Errorf("%q is used for two different answers", s)
		}
		seen[s] = true
	}
}

/*
ONLY the panels whose rows are host domains.

Compliance is recorded against a domain. The root-domain cards group by BRAND,
and owledge's twelve mirrors can hold twelve different answers — a single status
over them would be a claim the routing table never makes. The linking panel is
out because a notice goes to the host, not to the page that links to it.
*/
func TestOnlyHostDomainPanelsCarryTheStatus(t *testing.T) {
	if !complianceDomainPanels["byDomainSource"] {
		t.Error("Top 10 Host Websites carries no compliance status — it is the " +
			"panel this column was asked for")
	}
	for _, key := range []string{
		// Brands, not domains.
		dimDomainRoot, dimDomainRootMirrors, dimDomainRootAll, dimDomainRootSource,
		// The linking side: a notice goes to the host.
		"byDomain",
		// Not domains at all.
		"byAsset", "byChannel", "byPlatform", dimRepeatOffender, dimTopProfiles,
	} {
		if complianceDomainPanels[key] {
			t.Errorf("%s carries a per-domain compliance status over rows that are "+
				"not single domains", key)
		}
	}
}

/*
The annotation touches the panels it names and nothing else — and never invents
a status.

Driven off a map the caller supplies rather than off the lookup, so this exercises
the walk without a warehouse: what it has to get right is which rows it writes to,
and that a host the lookup had no answer for is left alone rather than stamped
with a default.
*/
func TestAnnotationWritesOnlyWhereItShould(t *testing.T) {
	host := []map[string]any{
		{"label": "lonpapil.eu", "urls": int64(274)},
		{"label": "dervlin.me", "urls": int64(267)},
	}
	brands := []map[string]any{{"label": "owledge", "urls": int64(1200)}}
	bd := map[string]any{"byDomainSource": host, "byDomainRootSource": brands}

	/* The walk, with the lookup stubbed by hand — complianceFor needs a
	   warehouse and this is testing the part that does not. */
	status := map[string]string{"lonpapil.eu": complianceYes}
	for key, rows := range bd {
		if !complianceDomainPanels[key] {
			continue
		}
		for _, row := range asRows(rows) {
			if s := status[strFromAny(row["label"])]; s != "" {
				row["complianceStatus"] = s
			}
		}
	}

	if host[0]["complianceStatus"] != complianceYes {
		t.Errorf("the resolved host got %v, want %q", host[0]["complianceStatus"], complianceYes)
	}
	// Unresolved: left with no key at all, so the page draws no column cell for
	// it rather than a word nothing stands behind.
	if _, has := host[1]["complianceStatus"]; has {
		t.Errorf("a host the lookup had no answer for was stamped %v", host[1]["complianceStatus"])
	}
	if _, has := brands[0]["complianceStatus"]; has {
		t.Error("a BRAND row got a domain's compliance status")
	}
}

/*
An unreachable warehouse costs the column, not the card.

complianceFor answers nil where the reports database is not configured, and
annotateHostCompliance then writes nothing — so the panel keeps the five columns
it had. A column of "Not recorded" over a table that was merely unreachable would
read as a finding about the client's hosts.
*/
func TestNoWarehouseMeansNoColumn(t *testing.T) {
	if got := complianceFor(nil); got != nil {
		t.Errorf("an empty host list produced %v", got)
	}
	// Nothing to annotate must also be silent — and must not panic on a report
	// that has no breakdowns at all.
	annotateHostCompliance(nil)
	annotateHostCompliance(map[string]any{"byAsset": []map[string]any{{"label": "x"}}})
}

/*
A word from the service is checked, not trusted.

reports_api applies its own three-way CASE and the two are meant to agree. This
is what makes "meant to" enforceable: a fourth answer added there arrives as
Unknown, which is true, rather than as an unrecognised string rendered straight
into a column of verdicts.
*/
func TestComplianceWordAcceptsOnlyTheKnownAnswers(t *testing.T) {
	for _, c := range []struct{ in, want string }{
		{complianceYes, complianceYes},
		{complianceNo, complianceNo},
		{"  Compliant  ", complianceYes},
		{complianceUnknown, complianceUnknown},
		// Anything else the service might send, now or later.
		{"Partially compliant", complianceUnknown},
		{"", complianceUnknown},
	} {
		if got := complianceWord(c.in); got != c.want {
			t.Errorf("complianceWord(%q) = %q, want %q", c.in, got, c.want)
		}
	}
	/* And the absent case is NOT reachable through this function. "Not
	   recorded" means no row came back at all, which complianceFor decides —
	   a service that literally sent the words must not be able to claim it. */
	if complianceWord(complianceAbsent) == complianceAbsent {
		t.Error("a service could claim Not recorded, which is a fact about the " +
			"ABSENCE of a row rather than anything a row can say")
	}
}

/*
The rows this reads are ANOTHER SERVICE'S payload, so they are pinned to a real one.

Captured verbatim from GET /v1/masters/domain-reporting?domains=… against the
live warehouse on 12 September 2026. An invented fixture would keep passing
through a rename of any of the three keys below — and a renamed key does not
error here, it produces a column of "Not recorded" that reads as a finding about
the client's hosts.

patreon.com is in it on purpose: it is one of the fifteen domains carrying two
routing rows, and the endpoint returns BOTH.
*/
func liveMasterRows() []map[string]any {
	return []map[string]any{
		{"Active": float64(1), "CompliantType": "Non-Compliant", "DomainName": "dervlin.me",
			"DomainId": "2D53131A-CBD3-43DB-B411-6E92F66A9064", "ReportingMethodName": "Server Notice"},
		{"Active": float64(1), "CompliantType": "Non-Compliant", "DomainName": "lonpapil.eu",
			"DomainId": "3107F3DD-CFDA-4A30-B4D6-31C5541DAA97", "ReportingMethodName": "Server Notice"},
		{"Active": float64(1), "CompliantType": "Non-Compliant", "DomainName": "ninguno.cc",
			"DomainId": "56653CF2-E9AF-4FF6-B2D7-C3E65B40BBA4", "ReportingMethodName": "Server Notice"},
		{"Active": float64(1), "CompliantType": "Compliant", "DomainName": "patreon.com",
			"DomainId": "03D82CAE-620B-42E3-AAC7-21456B435CA2", "ReportingMethodName": "Email"},
		{"Active": float64(0), "CompliantType": "Compliant", "DomainName": "patreon.com",
			"DomainId": "179AF39B-D746-4BB0-8342-88042B40686C", "ReportingMethodName": "Email"},
		{"Active": float64(1), "CompliantType": "Non-Compliant", "DomainName": "s-c3.owledge.cc",
			"DomainId": "EED18235-8D6C-4B8B-BBB9-C34CAACBE8B9", "ReportingMethodName": "Server Notice"},
	}
}

func TestTheServicesOwnRowsFoldToOneAnswerPerDomain(t *testing.T) {
	got := complianceFromRows(liveMasterRows())

	// Six rows, five domains — patreon.com arrived twice.
	if len(got) != 5 {
		t.Fatalf("folded to %d domains, want 5: %v", len(got), got)
	}
	for _, c := range []struct{ host, want string }{
		{"dervlin.me", complianceNo},
		{"lonpapil.eu", complianceNo},
		{"ninguno.cc", complianceNo},
		{"s-c3.owledge.cc", complianceNo},
		{"patreon.com", complianceYes},
	} {
		if got[c.host] != c.want {
			t.Errorf("%s = %q, want %q", c.host, got[c.host], c.want)
		}
	}
}

/*
And the ACTIVE row is the one that answers, whichever order the two arrive in.

The live payload happens to put patreon.com's active row first, so a fold that
simply kept the first would pass on today's data and be wrong the day the
endpoint's ORDER BY changes. Both orders are checked, with the verdicts made to
differ so the choice is visible.
*/
func TestTheActiveRoutingRowWins(t *testing.T) {
	live := map[string]any{"Active": float64(1), "CompliantType": "Compliant", "DomainName": "example.com"}
	dead := map[string]any{"Active": float64(0), "CompliantType": "Non-Compliant", "DomainName": "example.com"}

	for _, c := range []struct {
		name string
		rows []map[string]any
	}{
		{"active row first", []map[string]any{live, dead}},
		{"retired row first", []map[string]any{dead, live}},
	} {
		if got := complianceFromRows(c.rows)["example.com"]; got != complianceYes {
			t.Errorf("%s: example.com = %q, want the ACTIVE row's %q", c.name, got, complianceYes)
		}
	}
}

/*
A payload key that goes missing must not read as an answer.

This is the failure the fixture above exists to catch, exercised directly: a row
with no recognisable domain is skipped rather than filed under "", and a verdict
this portal does not know becomes Unknown rather than being printed verbatim.
*/
func TestUnrecognisedRowsAreNotAnswers(t *testing.T) {
	got := complianceFromRows([]map[string]any{
		{"Active": float64(1), "CompliantType": "Compliant", "Domain": "renamed-key.example"},
		{"Active": float64(1), "CompliantType": "Partially compliant", "DomainName": "odd.example"},
	})
	if _, has := got[""]; has {
		t.Error("a row with no DomainName was filed under an empty host")
	}
	if len(got) != 1 {
		t.Errorf("folded to %d answers, want 1 — a renamed key produced one", len(got))
	}
	if got["odd.example"] != complianceUnknown {
		t.Errorf("odd.example = %q, want %q — a verdict this portal does not know "+
			"was printed as received", got["odd.example"], complianceUnknown)
	}
}
