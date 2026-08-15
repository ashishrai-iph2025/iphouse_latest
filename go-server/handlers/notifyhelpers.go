package handlers

import (
	"strings"

	ipauth "github.com/ip-house/iphouse-api/auth"
	"github.com/ip-house/iphouse-api/notify"
)

// pushNotify stamps an admin notification with the acting session (who did it,
// and which client company they did it on) and raises it. Centralised so every
// trigger point attributes the actor identically — including when IP House
// staff are impersonating, where the acting client is the subject but the
// notification must still show whose hands were on the keyboard.
func pushNotify(claims *ipauth.Claims, ev notify.Event) {
	if claims != nil {
		ev.ActorLoginID = claims.LoginID
		ev.ActorUsername = claims.LoginUsername
		ev.ActorName = strings.TrimSpace(claims.LoginFirstName + " " + claims.LoginLastName)
		if ev.ActorName == "" {
			ev.ActorName = claims.LoginUsername
		}
		ev.ClientUserID = claims.UserID
		ev.ClientName = claims.ClientName

		if ev.Meta == nil {
			ev.Meta = map[string]any{}
		}
		if claims.ImpersonatorLoginID != 0 {
			// Otherwise the action reads as the client's own — it wasn't.
			ev.Meta["impersonatedBy"] = claims.ImpersonatorEmail
			ev.Meta["impersonatorName"] = claims.ImpersonatorName
		}
	}
	notify.Push(ev)
}

// plural returns "s" for anything other than exactly one.
func plural(n int) string {
	if n == 1 {
		return ""
	}
	return "s"
}

// orDash renders an empty date bound as an en dash in notification text.
func orDash(s string) string {
	if strings.TrimSpace(s) == "" {
		return "–"
	}
	return s
}

// forAsset renders an optional " · <asset>" suffix for notification text.
func forAsset(asset string) string {
	asset = strings.TrimSpace(asset)
	if asset == "" {
		return ""
	}
	return " · " + asset
}
