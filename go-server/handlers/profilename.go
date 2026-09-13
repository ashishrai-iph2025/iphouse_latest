package handlers

import "strings"

/*
── WHAT AN ACCOUNT IS CALLED ────────────────────────────────────────────────

	The profile panels rank accounts, and until now they labelled every row with
	the raw account URL. At the width a card gives a label that arrives as
	"https://vkvideo.ru/@vitals…" — the scheme and the host eat the space, and
	the part that identifies the account is the part that gets cut.

	A NAME WHERE THE TABLE HAS ONE. SocialMediaDashboard carries
	ChannelOrProfileUserName; the sports table beside it carries no name column
	at all, only ProfileURL. So this resolves a real name where there is one and
	derives a handle from the URL where there is not — and the two cases are
	kept apart below rather than blurred, because one is what the warehouse says
	the account is called and the other is this code's best reading of a string.
*/

// profileNameColumns are the spellings of an account's display name, most
// specific first — the same ordered-candidate convention the rest of the column
// inference uses.
var profileNameColumns = []string{
	"ChannelOrProfileUserName", "ChannelOrProfileName",
	"ProfileName", "ChannelName", "UserName",
}

// profileNameColumn picks the spelling a column list actually has, or empty
// where the table records no name — which is the sports social table.
func profileNameColumn(columns []string) string {
	return firstColumnOf(columns, profileNameColumns)
}

/*
firstColumnPresent is the fallback for when a dataset's DECLARED columns say
"no such field" but the rows say otherwise.

ds.Columns is reports_api's catalogue entry for a table — what it is EXPECTED
to hold — not a read of the payload in hand, and the two can drift: a field
added to the JSON without a matching catalogue update arrives on every row and
on no column list. RemovalProfileStatus did exactly that on one dataset, which
is why the reader saw every account as "Not Available" — computeTopProfiles was
handed an empty statusCol and had no column to read `dead` off, not because no
account was ever suspended.

Sampled rather than read off every row: whether a dataset carries a field does
not change row to row, so confirming what the first few already showed against
the rest of a large window is wasted work for the same answer.
*/
func firstColumnPresent(rows []map[string]any, candidates []string) string {
	const sample = 5
	for i, r := range rows {
		if i >= sample {
			break
		}
		for k := range r {
			for _, c := range candidates {
				if strings.EqualFold(k, c) {
					return k
				}
			}
		}
	}
	return ""
}

// profileLabel is what the panel prints for the account: the stored name where
// the warehouse has one, a handle read off the URL where it does not. The one
// rule both counting paths call — computeTopProfiles inline per row, and
// nameTopProfileRows below over the direct-SQL path's own rows — so a profile
// cannot be named one way in the API report and another in the warehouse one.
func profileLabel(name, url string) string {
	if n := strings.TrimSpace(name); n != "" {
		return n
	}
	return profileHandle(url)
}

// nameTopProfileRows fills in the label the direct-SQL path could not: the
// statement emits the stored name or '' (see topProfilesSQL) because SQL has no
// business deriving a handle from a URL. Applied here, once, so the two paths
// cannot drift on what an unnamed account is called.
func nameTopProfileRows(rows []map[string]any) []map[string]any {
	for _, r := range rows {
		r["label"] = profileLabel(strFromAny(r["label"]), strFromAny(r["value"]))
	}
	return rows
}

/*
profileHandle is the account as a reader would name it, taken from its URL.

Used ONLY where the table has no name column. It is a presentation of the URL
rather than a claim about the account: the value the panel filters on stays the
URL, and the full URL is still what the row's tooltip shows.

The last meaningful path segment, because that is where every one of these
platforms puts the account:

	vkvideo.ru/@vitalsport11              → @vitalsport11
	facebook.com/p/Some-Page-100012/      → Some-Page-100012
	youtube.com/channel/UCabc123          → UCabc123
	rutube.ru/u/versport/                 → versport

Query strings and fragments are dropped first — facebook.com/profile.php?id=123
is the exception that would otherwise yield "profile.php", so a numeric id in
the query is preferred over the script name. Anything this cannot read falls
back to the host, and then to the URL itself: an ugly label is recoverable, an
empty one is not.
*/
func profileHandle(rawURL string) string {
	u := strings.TrimSpace(rawURL)
	if u == "" {
		return ""
	}
	// Scheme and fragment carry nothing a reader wants.
	if i := strings.Index(u, "://"); i >= 0 {
		u = u[i+3:]
	}
	if i := strings.IndexByte(u, '#'); i >= 0 {
		u = u[:i]
	}

	path := u
	query := ""
	if i := strings.IndexByte(u, '?'); i >= 0 {
		path, query = u[:i], u[i+1:]
	}
	host := path
	if i := strings.IndexByte(path, '/'); i >= 0 {
		host, path = path[:i], path[i+1:]
	} else {
		path = ""
	}
	host = strings.TrimPrefix(host, "www.")

	/* profile.php?id=… — the segment is the script and the query is the
	   account. Checked before the segments below, because the segment would
	   otherwise win and every such row would read "profile.php". */
	if strings.Contains(strings.ToLower(path), ".php") {
		for _, part := range strings.Split(query, "&") {
			if k, v, ok := strings.Cut(part, "="); ok &&
				strings.EqualFold(strings.TrimSpace(k), "id") && strings.TrimSpace(v) != "" {
				return strings.TrimSpace(v)
			}
		}
	}

	segs := strings.Split(path, "/")
	for i := len(segs) - 1; i >= 0; i-- {
		if s := strings.TrimSpace(segs[i]); s != "" {
			return s
		}
	}
	if host != "" {
		return host
	}
	return strings.TrimSpace(rawURL)
}
