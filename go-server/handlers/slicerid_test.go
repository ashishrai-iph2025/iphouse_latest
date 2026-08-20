package handlers

// looksLikeID decides what vanishes from a slicer, so a false positive removes
// a real, pickable option and nobody is told. The real values below are taken
// from the warehouse's own dimensions.

import "testing"

func TestLooksLikeID(t *testing.T) {
	ids := []string{
		"34D6E91B-4136-4C25-B883-CBA7E08DAD19",
		"2e4e04ca-7a92-4a78-82df-a297e08dad19", // lower case is the same shape
		"0001743e788ea6a69dc52ff4240dc916",     // the 32-char hash key on SportsURLRawData
	}
	for _, v := range ids {
		if !looksLikeID(v) {
			t.Errorf("%q should be treated as an id", v)
		}
	}

	// Everything a reader actually picks from. Each of these is its own label
	// and must survive — dropping one empties a working slicer.
	names := []string{
		"Bot", "Clip Pirate Content", "Copyright Infringement", "Credential Sharing",
		"Pending", "0-6 hours", "1hr - 2hr", "00 - 30min", "2 hrs and above",
		"HDRip", "English", "Global", "Website", "VKvideo", "Private",
		"Sports", "Highlights", "Paramount Pictures", "sportfusion.me",
		"WTA - Toronto Open", "", "—",
		// Near misses: right length, wrong content. A 36-character TITLE must
		// not be mistaken for a GUID.
		"Belgian Pro League: Club Brugge x Kor",
		"34D6E91B-4136-4C25-B883-CBA7E08DADZZ", // non-hex tail
		"34D6E91B41364C25B883CBA7E08DAD19",     // 32 chars but hex — see below
	}
	for _, v := range names {
		if v == "34D6E91B41364C25B883CBA7E08DAD19" {
			// This one IS hex and 32 long, so it is correctly an id. Asserted
			// explicitly rather than left ambiguous in the list above.
			if !looksLikeID(v) {
				t.Errorf("%q is a 32-char hex hash and should be treated as an id", v)
			}
			continue
		}
		if looksLikeID(v) {
			t.Errorf("%q is a name and must not be dropped from a slicer", v)
		}
	}
}
