package handlers

import (
	"net/http"

	"github.com/ip-house/iphouse-api/geoip"
	"github.com/ip-house/iphouse-api/middleware"
)

/*
GET /api/geo/country

Which country this request appears to come from, so the portal can render UTC
timestamps in the reader's own clock (see lib/timezone.tsx).

This answers from the IP, which is the only signal that follows a VPN or a
corporate egress — the browser's own geolocation reports where the DEVICE is and
is unmoved by either. The lookup runs in-process against an embedded table, so
no client address is sent anywhere.

`country` is empty when the address is not in the table. That is the honest
answer for a private or loopback peer, which is what every request looks like
when the portal is opened on localhost: the browser never puts the request on
the network, so there is no public IP to read. The page falls back to the
device's location and then to its own time zone, and says which it used.
*/
func GeoCountry(w http.ResponseWriter, r *http.Request) {
	ip := middleware.ClientIP(r)
	cc := geoip.CountryOf(ip)

	out := map[string]any{
		"success": true,
		"country": cc,
	}
	if cc == "" {
		// Named so the picker can say WHY rather than just showing nothing. A
		// developer on localhost and a client behind an unlisted range are the
		// same empty answer and want different explanations.
		out["reason"] = "private-or-unknown-address"
	}
	// Deliberately NOT returning the address itself. The client already knows
	// its own IP if it wants it, and an endpoint that echoes one is a thing that
	// ends up in a log or a screenshot.
	OK(w, out)
}
