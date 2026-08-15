package handlers

import (
	"strings"

	"github.com/ip-house/iphouse-api/markscan"
)

// platformDisplay turns an upstream platform name into the one the portal shows.
//
// "Internet" is MarkScan's name for the open web, and it is what every request
// and stored row carries — but nobody outside the API calls it that, so the UI
// reads "Open Web" throughout. Notification and email text is composed here on
// the server, so it has to do the same translation the client does
// (lib/platformCategories.ts: platformLabel) or the bell would contradict the
// page it links to.
//
// Display only. Never feed the result back into a request, a stored row, or a
// comparison — markscan.PlatformLabels is keyed on the real names.
func platformDisplay(name string) string {
	n := strings.TrimSpace(name)
	if n == "" {
		return n
	}
	if label, ok := markscan.PlatformLabels[strings.ToLower(n)]; ok {
		return label
	}
	return n
}
