package handlers

/*
What every panel MEANS — the note behind the ⓘ on its card.

A report card carries a title and a number, and neither says how the number was
arrived at. "Notices Sent 636" against "Total Infringements 13,169" invites the
reading that 636 of those URLs got a notice, when in truth 636 NOTICES covered
all 13,169 — two figures on one screen, one of them four orders of magnitude off
the reading a reasonable person gives it. The distinctions this file spells out
are exactly the ones that are invisible from the card.

These are DEFAULTS, not fixed text. An admin overrides any of them per platform
and per client in Report Configuration → Page Layout, and what they write wins;
the default is what the card says until somebody has something better to say. It
also fills the editor's placeholder there, so the wording can be adjusted rather
than composed from nothing.

A panel with no entry here gets no ⓘ at all. An empty string is the honest answer
for a panel nobody has described — better than a generic sentence that restates
the title and teaches the reader to ignore the icon.
*/

// kpiTileDescriptions is what each headline figure counts, keyed by its metric.
// The COUNTING RULE is the point of each one: what a figure counts once, what it
// counts per row, and what it deliberately excludes.
var kpiTileDescriptions = map[string]string{
	"identified": "Every infringing URL found in this window, across all the sources this report reads.",
	"removed":    "How many of the URLs identified in this window have since come down.",
	"removalPct": "Removed as a share of identified — the enforcement rate for this window, not an all-time figure.",
	"pending":    "Identified URLs that are still live: found, and not yet removed.",

	"totalAssets":   "Distinct titles the identified URLs were matched against.",
	"totalDomains":  "Distinct websites the identified URLs were found on — one site however many URLs it carried.",
	"totalChannels": "Distinct channels or accounts carrying the identified URLs.",
	"totalPlaces":   "Distinct websites, channels and pages the infringements were found on, counted together.",

	"channelsSuspended": "Channels or websites taken down in full, rather than a single URL removed from them.",
	"profilesSuspended": "Social accounts taken down in full, rather than a single post removed from them.",
	"suspendedWebsites": "Websites taken down in full, rather than a single URL removed from them.",

	"impactedSubscribers": "Combined subscriber count of the channels carrying infringements — the audience they could reach, not the audience they did.",
	"impactedTraffic":     "Estimated traffic to the pages carrying infringing content.",
	"views":               "Total views on the infringing content found in this window.",
	"viewsImpacted":       "Views on the infringing content that is now DOWN — the share of the audience above that the takedowns removed. Counted where the removal status is Dead.",
	"totalTVChannels":     "A count of the distinct TV channel names on the infringements found. Rows with no channel name recorded are not counted, exactly as a distinct count does not count them. Not the same as Channels beside it, which counts accounts rather than channel names.",
	"viewsSaved":          "Views the infringing content would have gone on to take, counted from what came down.",
	"savedRevenue":        "Views saved, valued at a fixed per-view rate set in the server configuration. A range because the rate is a commercial assumption, not a measurement.",
	"likes":               "Total likes on the infringing content found in this window.",
	"crawled":             "URLs crawled while searching, whether or not they turned out to be infringing.",

	/* The two that are most often misread, and the reason this file exists: an
	   action id is stamped on every URL it covered, so the row count answers a
	   different question by four orders of magnitude. */
	"notices":          "Distinct takedown notices sent to hosting providers — counted once each, not once per URL they covered.",
	"delistingBatches": "Distinct de-indexing sent to search engines — counted once each, not once per link they covered.",

	"googleDelisted": "Links Google has dropped from its search results.",
	"bingDelisted":   "Links Bing has dropped from its search results.",
	"delisted":       "Links search engines have dropped from their results. Not the same as removal — a de-indexed page is still live, just harder to find.",

	"totalApps":         "Distinct app titles found across the stores this report reads.",
	"totalCategories":   "Distinct store categories the infringing apps were listed under.",
	"totalDevelopers":   "Distinct developer accounts behind the infringing apps.",
	"installs":          "Combined install count of the infringing apps.",
	"ratings":           "Combined rating count of the infringing apps.",
	"reviews":           "Combined review count of the infringing apps.",
	"avgStars":          "Mean star rating across the infringing apps.",
	"enforced":          "Listings an enforcement action has been raised against.",
	"sourceRemoved":     "Store listings taken down.",
	"infringingRemoved": "Download links taken down.",
}

// dimDescriptions is what each breakdown groups by, keyed by dimension.
var dimDescriptions = map[string]string{
	/* The pair that are easiest to mistake for one another — one splits by
	   social platform, the other by channel — so each says what the other is. */
	"byPlatform":      "Where the infringements were found, by social platform. This groups by the social tables' own Platform column, so the open web, Telegram and the app stores are not in it — they are split out on the per-channel panel.",
	dimSourcePlatform: "Each channel this report covers — the open web, social media, Telegram, the app stores — with its own identified and removed figures. The panel the rest of the page is read through.",

	"byDomain":            "The websites LINKING to infringing content, ranked by how many links were found on each.",
	"byDomainSource":      "The websites HOSTING infringing content, ranked by how many were found on each.",
	"byDomainRoot":        "Infringing sites grouped by brand, so a site and its mirrors count as one.",
	"byDomainRootMirrors": "How many distinct hostnames each brand was seen under — its mirror count, not its URL count.",

	"byAsset":     "The titles most affected, by how many infringing URLs were matched to each.",
	"byAssetName": "The titles most affected, by how many infringing URLs were matched to each.",
	"byChannel":   "The channels or accounts carrying the most infringing content.",

	/* Days, not volume — the whole point of the panel, and invisible from a bar
	   whose length is the URL count. */
	dimRepeatOffender: "Accounts ranked by how many separate DAYS they were caught on, not by how much they posted. One account with a busy afternoon is not a repeat offender; one caught again three weeks later is.",

	"byLanguage":           "The languages the infringing content was published in.",
	"byLanguageId":         "The languages the infringing content was published in.",
	"byCountry":            "Where the infringing content was published or hosted.",
	"byCountryId":          "Where the infringing content was published or hosted.",
	"byGenre":              "The genres of the titles that were infringed.",
	"byGenreId":            "The genres of the titles that were infringed.",
	"byQuality":            "The print quality of the infringing copies.",
	"byQualityId":          "The print quality of the infringing copies.",
	"byInfringementType":   "What kind of infringement each URL was.",
	"byInfringementTypeId": "What kind of infringement each URL was.",
	"byDeliveryType":       "How the infringing copy reaches a viewer — download, stream or torrent.",
	"byGroupType":          "Whether the source was a channel or a group.",
	"byKeyword":            "The search terms the infringing pages were found under.",
	"byRemovalStatus":      "Where each identified URL currently stands in the removal process.",
	"byTAT":                "How long removals took, in buckets — from a URL being identified to it coming down. Only the URLs that HAVE come down are in it.",

	"bySearchEngine":   "Which search engines surfaced the infringing links.",
	"bySearchEngineId": "Which search engines surfaced the infringing links.",
	/* Notices, not the URLs they covered — same trap as the KPI tile. */
	"bySearchEngineNotices": "How many enforcement notices went to each search engine. Notices, not the URLs they covered.",
	"byDelistingStatus":     "Infringing links found, against how many of them each search engine has dropped.",

	dimHSPNotices:             "How many distinct takedown notices each hosting provider received — counted once each, not once per URL the notice listed.",
	dimHSPDelisting:           "How many distinct de-indexing submissions covered links hosted by each provider — counted once each, not once per link the submission contained. The notices panel counts what was sent TO a provider; this counts what was sent to search engines ABOUT it.",
	dimEngineDelistingBatches: "How many distinct de-indexing each search engine received — counted once each, not once per link the submission contained.",
	dimNoticesByDay:           "How many distinct notices went out on each upload date. A notice covering two days' URLs counts on both — the question is what went out that day.",
	dimBatchesByDay:           "How many distinct de-indexing were sent on each upload date.",

	"byFranchise": "Identification and removal per franchise. A closed list, so every franchise is shown rather than a top ten.",
	"byMatchDay":  "Identification and removal per match day. A closed list, so every match day is shown rather than a top ten.",

	"byApp":           "The app titles found, ranked by how many listings each had.",
	"byCategory":      "The store categories the infringing apps were listed under.",
	"byDeveloper":     "The developer accounts behind the infringing apps.",
	"byStoreType":     "Official store listings against third-party ones.",
	"byContentRating": "The content rating each infringing app carried.",
	"bySourceFeed":    "Which feed each listing came in on.",
}

// filterDescriptions is what each slicer narrows, keyed by its query parameter.
var filterDescriptions = map[string]string{
	"assetId":          "Narrow every panel to one title.",
	"language":         "Narrow to content published in one language.",
	"country":          "Narrow to one country.",
	"searchEngine":     "Narrow to links surfaced by one search engine.",
	"tatBucket":        "Narrow to removals that took a particular length of time.",
	"platform":         "Narrow to one social platform.",
	"channel":          "Narrow to one channel by name.",
	"channelUrl":       "Narrow to one account by its URL. Picked off the repeat-offenders panel rather than a dropdown — there are too many URLs to list.",
	"groupType":        "Narrow to channels or to groups.",
	"quality":          "Narrow to one print quality.",
	"genre":            "Narrow to one genre.",
	"infringementType": "Narrow to one kind of infringement.",
	"deliveryType":     "Narrow to one delivery method — download, stream or torrent.",
	"keyword":          "Narrow to pages found under one search term.",
	"domain":           "Narrow to one website.",
	"hspName":          "Narrow to sites answered for by one hosting provider — the party a notice is sent to, not the site itself.",
	"franchiseName":    "Narrow to one franchise.",
	"matchDay":         "Narrow to one match day.",
	"sourceFeed":       "Narrow to listings from one feed.",
	"appName":          "Narrow to one app.",
	"category":         "Narrow to one store category.",
	"developer":        "Narrow to one developer account.",
	"storeType":        "Narrow to official listings or to third-party ones.",
	"contentRating":    "Narrow to one content rating.",
	"removalStatus":    "Narrow to URLs at one stage of the removal process.",
	/* The one slicer that picks a SIDE rather than a value, so its note has a
	   second job: the report's own panels call these two sides Linking and
	   Host, while the warehouse — and this dropdown — call them Infringing and
	   Source. A reader who is not told they are the same two things reads the
	   control as a third dimension. */
	"sourceType": "Read one side of the open web instead of both. Infringing is the linking pages (the Linking panels); Source is the hosts behind them (the Host panels). Left unset, every figure covers both added together.",
}

/*
trendPanelDesc is what a trend card plots, worded for the side it draws.

Built where the panel is, rather than looked up, because it has to name the same
second measure the chart's own legend does — and only defaultPanels knows which
side carries a delisting figure. A card promising "delisted" over a chart drawing
removals would be the exact kind of quiet wrongness this file exists to prevent.
*/
func trendPanelDesc(role string, delisting map[string]bool) string {
	if role == "" {
		return "Infringing URLs found against those taken down, period by period. " +
			"The subtitle under the title says which period."
	}
	side := role
	if n, ok := roleDisplayName[role]; ok {
		side = n
	}
	second := "taken down"
	if delisting[role] {
		second = "dropped by search engines"
	}
	return side + " URLs found against those " + second + ", period by period. " +
		"The other trend beside it draws the report's other side."
}

// defaultPanelDesc is the note a panel carries when nobody has written one —
// looked up by whichever of its fields identifies it.
func defaultPanelDesc(p panelDef) string {
	switch p.Kind {
	case panelTile:
		return kpiTileDescriptions[p.Metric]
	case panelDim:
		return dimDescriptions[p.Key]
	case panelFilter:
		return filterDescriptions[p.Param]
	case panelRate:
		return "The share of each period's identified URLs that came down. " +
			"On its own card rather than a second line on the trend: two scales in one " +
			"plot invite a correlation that is really just where the axes were pinned."
	}
	// Trends carry theirs from defaultPanels, and a heading has its own subtitle.
	return ""
}

// panelDescOf is the note a panel actually shows: what the admin wrote, or the
// built-in one until they write something.
func panelDescOf(p panelDef) string {
	if p.Desc != "" {
		return p.Desc
	}
	if p.DefaultDesc != "" {
		return p.DefaultDesc
	}
	return defaultPanelDesc(p)
}
