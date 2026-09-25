package handlers

/*
summaryWebsites is one table's share of a SUMMARY's Total Websites tile.

On an ordinary report the tile is what its name says — distinct domains — and
that is what every table with a domain column reports as totalDomains. A summary
reads several channels, and a domain-only count left the tile blind to two of
them: the social and Telegram tables have no domain column, so their profiles
and channels — each a place the content was found, exactly as a website is —
added nothing. On the Sports Summary the tile was the Open Web domains alone.

So on a summary the tile is composed per channel:

	Open Web            totalDomains  — distinct InfringingDomain on the linking
	                                    table, distinct SourceDomain on the host
	Social Media / UGC  totalChannels — distinct ProfileURL
	Telegram            totalChannels — distinct ChannelURL

and summed. Summed, not deduplicated, as the built-in summary's "No. of Website /
Channel / Page" is: a profile URL and a domain are never the same value, and a
site that both links and hosts is counted once per side, which is how the two
Open Web domain tiles beside this one read it too.

Mobile Apps is NOT counted: its rows are store listings, and a listing's domain is
the store or the download site rather than a place a viewer went to watch.

ok is false for a table that contributes nothing, so a summary made only of such
tables keeps the tile it had.
*/
func summaryWebsites(table string, kpi map[string]any) (int64, bool) {
	key := ""
	switch sourceChannelName(table) {
	case "Open Web":
		key = "totalDomains"
	case "Social Media / UGC", "Telegram":
		key = "totalChannels"
	default:
		return 0, false
	}
	v, ok := kpi[key]
	if !ok {
		return 0, false
	}
	return numOf(v), true
}
