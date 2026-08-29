package handlers

import "testing"

/*
A dashboard module finds its report by NAME, and the join is the load-bearing
part of this feature: get it wrong in the widening direction and an admin grants
one client's report and hands over another's; get it wrong in the narrowing
direction and a correctly configured account opens nothing.

Both catalogues are typed by hand into different screens, so the test cases below
are the disagreements that actually happen between two people typing the same
name — punctuation, spacing, case — plus the one that must NOT be forgiven.
*/
func TestDashboardModuleKeyMatchesPlatformLabel(t *testing.T) {
	for _, tc := range []struct {
		name     string
		module   string
		category string
		label    string
		want     bool
	}{
		{"exact, with the dash the label uses",
			"Open Web", "VOD", "Open Web - VOD", true},
		// The three ways a separator gets typed. All the same report.
		{"en dash", "Open Web", "VOD", "Open Web – VOD", true},
		{"em dash", "Open Web", "VOD", "Open Web — VOD", true},
		{"no separator at all", "Open Web", "VOD", "Open Web VOD", true},
		{"case differs", "open web", "vod", "Open Web - VOD", true},
		{"stray whitespace", "  Open Web  ", "VOD", "Open Web-VOD", true},
		{"ampersand in the subject",
			"UGC & Social Media", "Sports", "UGC & Social Media - Sports", true},

		/* THE ONE THAT MUST NOT MATCH.

		   Two modules share a name and are told apart only by their category.
		   If either matched the other's label, granting the VOD report would
		   hand over the sports one — which is the entire distinction the
		   category column was added to draw. */
		{"the other category's report", "Open Web", "VOD", "Open Web - Sports", false},
		{"a different subject", "Telegram", "VOD", "Open Web - VOD", false},

		/* A categorised module deliberately does NOT match an unqualified
		   label. Matching would make "Open Web / VOD" and "Open Web / Sports"
		   both resolve to a platform called plainly "Open Web", so granting
		   one would grant the other. The picker reports the miss instead. */
		{"categorised module against an unqualified label",
			"Open Web", "VOD", "Open Web", false},

		// An uncategorised module has not been told which cut it is, so the
		// only honest match is a label that does not name a cut either.
		{"uncategorised against an unqualified label",
			"Open Web", "", "Open Web", true},
		{"uncategorised against a qualified label",
			"Open Web", "", "Open Web - VOD", false},
		{"whitespace-only category counts as uncategorised",
			"Open Web", "   ", "Open Web", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := dashboardModuleKey(tc.module, tc.category) == normaliseReportName(tc.label)
			if got != tc.want {
				t.Fatalf("module %q/%q vs label %q: got match=%v, want %v",
					tc.module, tc.category, tc.label, got, tc.want)
			}
		})
	}
}
