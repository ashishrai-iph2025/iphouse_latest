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
	"pending":    "Identified URLs that are still active: found, and not yet removed.",

	"totalAssets":   "Distinct titles the identified URLs were matched against.",
	"totalDomains":  "Distinct websites the identified URLs were found on — one site however many URLs it carried.",
	"totalChannels": "Distinct channels or accounts carrying the identified URLs.",
	"totalPlaces":   "Distinct websites, channels and pages the infringements were found on, counted together.",

	"channelsSuspended": "Channels or websites taken down in full, rather than a single URL removed from them.",
	"profilesSuspended": "Social accounts taken down in full, rather than a single post removed from them.",
	"suspendedWebsites": "Websites taken down in full, rather than a single URL removed from them.",

	"impactedSubscribers": "Combined subscriber count of the channels carrying infringements — the audience they could reach, not the audience they did. Counted only on accounts that have been SUSPENDED, so it is the reach enforcement has taken off the table; Total Subscribers is the whole of it.",
	"totalSubscribers":    "The combined audience of every profile found infringing in this window — one figure per account, taken as its highest reading, however many posts it made. NOT a sum of the column: an account appears on every post, so adding it up counts the same followers over and over. Total Channels is how many accounts that audience is spread across.",
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
	"delisted":       "Links search engines have dropped from their results. Not the same as removal — a de-indexed page is still active, just harder to find.",

	/* ── The two-sided open-web split ────────────────────────────────────────

	   Each of these is one HALF of a figure the band already carries whole, so
	   each note says which half — and the linking/host distinction is the one
	   thing about this report a reader cannot infer from a number. */
	"linkingIdentified": "Infringing URLs found on the LINKING side — the pages that point at the content. The host side has its own tile; Total Infringements is the two added together.",
	"hostIdentified":    "Infringing URLs found on the HOST side — the machines actually holding the content. The linking side has its own tile; Total Infringements is the two added together.",
	"linkingDomains":    "Distinct websites on the linking side — one site however many links were found on it.",
	"hostDomains":       "Distinct websites on the host side — one site however many files were found on it.",
	/* The pair most likely to be misread as a domain count, so both say what a
	   brand IS. The figure is deliberately far smaller than the domain count
	   beside it, and that gap is the finding: it is how many hosts each operator
	   is running. */
	"linkingBrands": "Distinct pirate BRANDS on the linking side — a site and all its mirrors counted once, so livetv.sx, livetv901.me and cdn.livetv872.me are one operator. Always lower than Total Linking Domains, and the gap between the two is how many mirrors the operators are running.",
	"hostBrands":    "Distinct pirate BRANDS on the host side — a site and all its mirrors counted once. Always lower than Total Host Domains; the gap is the mirror count.",

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
	"byDomainSource":      "The websites HOSTING infringing content, ranked by how many were found on each. Each one carries whether it has honoured a notice before — Compliant, Non-Compliant, Unknown where the routing table records the domain without saying, and Not recorded where no notice route has been set up for it at all. That is a fact about the domain's history rather than about this window, so it does not move with the date range; it comes from the same takedown routing table the enforcement flow sends by.",
	"byDomainRoot":        "Infringing sites grouped by brand, so a site and its mirrors count as one.",
	"byDomainRootMirrors": "How many distinct mirror domains each brand was seen under — its mirror count, not its URL count. Switch to TABLE to read the domains themselves.",
	dimTVChannel:          "The BROADCASTER whose feed was taken — the station behind the stream, not the account that restreamed it. Which column holds that name differs by source: on the open-web tables it is the channel name itself, because those rows carry no account; everywhere else it is the dedicated TV-channel column, since there the channel name belongs to the pirate. \"No Logo\" is a real value and not a gap — it means the capture carried no broadcaster mark. The Top 10 Channels panel answers the other half: who took it.",
	dimAppSource:          "Where each infringing app was found: the two official stores against the third-party feeds. The four sources are not one problem — a takedown on Google Play is a form and a wait, and the same app on a third-party site is different work with a different success rate — so the report separates them rather than adding them together. Removal here is the source URL confirmed dead, which is the same test the KPI band above counts.",
	"byDomainRootAll":     "The LINKING side, per brand: infringing URLs found on the operator's linking domains, how many of those Google approved for de-indexing, and how many distinct mirror domains it was running. Linking domains only — the pages that point at infringing content, never the ones hosting it, which have their own card. The mirror count is drawn on its own scale beside the volume bars, never on the same axis: it counts domains, and the volumes beside it count URLs, orders of magnitude larger. Switch to TABLE for the de-indexing rate and share. The mirror count also OPENS: click it to list the domains behind it, and the same list travels as a column in the table view and in the download.",
	"byDomainRootSource":  "The HOST side, per brand: infringing URLs found on the operator's host domains, how many came down, and how many distinct mirror domains it was running. Host domains only. Its second measure is removal — a notice the host acted on — which is a different fact from the linking card's de-indexing, so the two are never added together. The mirror count is drawn on its own scale beside the volume bars. Switch to TABLE for the removal rate and share. The mirror count also OPENS: click it to list the domains behind it, and the same list travels as a column in the table view and in the download.",

	dimTopProfiles: "The ten accounts with the biggest AUDIENCE, with what was found on each, what came down, and whether the account itself is still up. Ranked by followers rather than by volume — the repeat-offender panel answers who gives us the most work; this one answers who reaches the most people, and an account with a handful of posts and millions of followers appears on this card and not that one. The follower figure is each account's own highest reading in the window, never a sum across its posts.",

	"byAsset":     "The titles most affected, by how many infringing URLs were matched to each.",
	"byAssetName": "The titles most affected, by how many infringing URLs were matched to each.",
	"byChannel":   "The channels or accounts carrying the most infringing content.",

	/* Days, not volume — the whole point of the panel, and invisible from a bar
	   whose length is the URL count. */
	dimRepeatOffender: "Channels and profiles ranked by how many times they came BACK — content went up, we got it removed, and more content went up on the same account afterwards. URLs found in one sweep count as one offence, so a busy afternoon is not a repeat; a return two hours after a takedown is. Beside the count is the account's own state: Suspended where the platform closed it, Not Available where it is still up or was never reported. A high count still reading Not Available is the account defying enforcement. Accounts we have never removed anything from do not appear here at all — they are not repeat offenders, and the Top Channels card beside this one ranks by volume.",

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

	dimHSPNotices:             "What each hosting provider answers for on the HOST side: how much was found on the sites it carries, how much came down, how many distinct host domains it is running, and how many takedown notices it received — each notice counted once, not once per URL it listed. The domain gauge OPENS: click it to list the domains themselves. The notices gauge does not, because its rows are notice ids rather than anything a reader can act on.",
	dimHSPDelisting:           "The same providers on the LINKING side: how much was found on the linking domains they carry, how much Google approved for de-indexing, and how many distinct linking domains each is running. Click the domain gauge to list them. Paired with the host card above — a provider can run a large linking estate and a small hosting one, and the two cards exist to show that apart.",
	dimEngineDelistingBatches: "How many distinct de-indexing each search engine received — counted once each, not once per link the submission contained.",
	dimNoticesByDay:           "How many distinct notices went out on each upload date. A notice covering two days' URLs counts on both — the question is what went out that day.",
	dimBatchesByDay:           "How many distinct de-indexing were sent on each upload date.",

	"byFranchise":   "The competitions being pirated most, by how many infringing URLs were matched to each. A top ten by default — the cut is set per client in Report Configuration, and the heading restates whatever it is, so a franchise that fell outside it is never silently missing.",
	dimOverallByDay: "What was found and what came down on each day of the window, both sides of the report added together — the linking pages and the hosts as one movement rather than the two trend cards read separately. Every day is drawn, including the quiet ones, so the gaps are real gaps.",
	"byMatchDay":    "Identification and removal per match day. A closed list, so every match day is shown rather than a top ten.",

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

	/* The two values OVERLAP, and the description has to say so or the control
	   reads as a two-way split whose halves should add up to the whole. They do
	   not: end-to-end IS the whole. Named by the stages rather than by the
	   engagement alone, because a reader checking a figure against the asset
	   list needs to know which titles are in and the stage is what says so. */
	"repeatPlatform": "Narrow the repeat-offender ranking to one platform — and ONLY that panel. Every other slicer here narrows the whole page; this one leaves the rest of the report on all the platforms it covers, so you can ask which accounts keep coming back on TikTok without taking the KPI band and the charts off everything else.",

	"pirateBrand": "Narrow to one pirate operator — a site and all its mirrors together, so picking livetv covers livetv.sx, livetv901.me and cdn.livetv872.me at once. The brand is worked out from the hostname, not stored, so the list is the operators actually seen in this window. LINKING SIDE ONLY: the host table records no linking domain, so choosing a brand shows the linking half of the report rather than mixing a brand-scoped figure with an all-hosts one.",

	"monitoringScope": "How far into the takedown workflow to read. Monitoring Only covers titles at Discovery, Discovery QC or Enforcement QC; End to End covers all six stages, which is every title — so it narrows nothing and is the report you see with this unset. The stage is a property of the title, from the asset master.",
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
	case panelRealtime:
		/* Deliberately about WHAT THE CARD IS rather than what one reading of it
		   holds. The card's own note — scopeNote in RealtimeCard.tsx — already
		   says the season it covered, what it was narrowed to, and whether a
		   platform failed to answer, and all three change between readings, so
		   nothing this file could write would stay true. That note is kept
		   whatever an admin writes here: theirs is shown above it, not instead
		   of it, because losing "2 platforms could not be counted on this
		   reading" to a rename would be losing the one line that says the total
		   is a floor. */
		return "A live count, read straight from the enforcement side and refreshed on its own " +
			"while the page is open — not a figure from the prepared tables the rest of this " +
			"report is drawn from, so the two are not expected to tie out. It covers the " +
			"client's configured season, narrowed to whichever of match day, asset or " +
			"franchise put it on screen; the date range does not move it."
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
