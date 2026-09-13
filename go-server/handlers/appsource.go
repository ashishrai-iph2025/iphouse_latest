package handlers

import "strings"

/*
── WHERE A MOBILE-APP INFRINGEMENT WAS FOUND ────────────────────────────────

	The mobile-apps report covers four different sources — the two official
	stores and two third-party feeds — and until now nothing on the page said
	which. A client looking at 474 identifications could not tell whether they
	were on Google Play, where a takedown is a form and a wait, or on a
	third-party APK site, where it is a different piece of work entirely.

	The warehouse records it in SourceTable, which is a TABLE NAME rather than a
	label: "GooglePlayStoreURLsNEW". That is the reason this file exists — the
	column is groupable as it stands, and a panel drawn straight off it would
	put four internal table names on a client's report.
*/
const dimAppSource = "bySourceTable"

/*
appSourceNames maps the warehouse's table names to what they are.

Keyed LOWERCASE because the warehouse is not consistent about the suffix — three
of these end "URLsNEW" and the fourth "URLsNew", and an exact match would leave
that one showing its raw name beside three tidy ones. Verified against the live
catalogue rather than guessed: these four are every value the dataset returns.

A value not listed here keeps its raw name. That is deliberate and it is the
same rule the rest of this package follows for an unrecognised source: a table
added upstream shows up as itself, which is ugly and findable, rather than being
folded into a neighbour or dropped.
*/
var appSourceNames = map[string]string{
	"googleplaystoreurlsnew":     "Google Play Store",
	"itunesurlsnew":              "Apple App Store",
	"thirdpartyappsurlsnew":      "Third-Party Apps",
	"thirdpartymobileappurlsnew": "Third-Party Mobile Apps",
}

// appSourceName is what the panel calls one SourceTable value.
func appSourceName(raw string) string {
	v := strings.TrimSpace(raw)
	if v == "" {
		return "Unknown"
	}
	if name, ok := appSourceNames[strings.ToLower(v)]; ok {
		return name
	}
	return v
}

/*
nameAppSourceRows relabels a SourceTable breakdown in place.

Only the LABEL. `value` keeps the warehouse's own string, because that is what a
click on the panel filters by and what the slicer's options are built from —
renaming it would produce a filter for "Google Play Store" against a column that
contains "GooglePlayStoreURLsNEW" and return an empty report with no error.

The same split LookupTable makes for id-based dimensions, done here because
there is no lookup table to join: the mapping is ours, not the warehouse's.
*/
func nameAppSourceRows(rows []map[string]any) []map[string]any {
	for _, r := range rows {
		raw := strFromAny(r["label"])
		if _, has := r["value"]; !has {
			r["value"] = raw
		}
		r["label"] = appSourceName(raw)
	}
	return rows
}
