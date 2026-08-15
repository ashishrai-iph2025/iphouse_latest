// Package geoip answers "which country is this IP address in?" from a table
// compiled into the binary.
//
// WHY LOCAL: the alternative is asking a third-party geolocation service, which
// means every client's IP address leaves this infrastructure on a timer. The
// portal shows a client their own enforcement data; posting their address to an
// outside company so a clock can be labelled is not a trade worth making. The
// table below is public RIR data, costs one embedded file, and answers in
// microseconds with no network call at all.
//
// WHAT IT IS: the five regional registries publish which ranges they delegated
// to which country. That is authoritative for allocation and approximate for
// presence — a range delegated to a company in one country can be announced
// from another, and it says nothing about where a person is sitting. It is the
// right precision for choosing which clock to render timestamps in and the
// wrong precision for anything that turns on where someone actually is.
//
// See geoip/ipcountry.txt for the format and how to regenerate it.
package geoip

import (
	_ "embed"
	"net"
	"sort"
	"strconv"
	"strings"
	"sync"
)

//go:embed ipcountry.txt
var raw string

type v4Range struct {
	start, end uint32
	cc         string
}

type v6Range struct {
	start, end uint64 // top 64 bits; country delegations are never finer
	cc         string
}

var (
	once sync.Once
	v4   []v4Range
	v6   []v6Range
)

// load expands the delta-encoded table once, on first lookup rather than at
// init: a deployment that never calls this pays nothing but the embedded bytes.
func load() {
	section := ""
	var prev4 uint64
	var prev6 uint64

	for _, line := range strings.Split(raw, "\n") {
		if line == "" || line[0] == '#' {
			continue
		}
		if line[0] == ':' {
			section = line[1:]
			continue
		}
		gapStr, rest, ok := strings.Cut(line, " ")
		if !ok {
			continue
		}
		lenStr, cc, ok := strings.Cut(rest, " ")
		if !ok || len(cc) != 2 {
			continue
		}
		gap, err1 := strconv.ParseUint(gapStr, 36, 64)
		size, err2 := strconv.ParseUint(lenStr, 36, 64)
		if err1 != nil || err2 != nil {
			continue
		}

		switch section {
		case "v4":
			start := prev4 + gap
			end := start + size
			prev4 = end + 1
			v4 = append(v4, v4Range{uint32(start), uint32(end), cc})
		case "v6":
			start := prev6 + gap
			end := start + size
			prev6 = end + 1
			v6 = append(v6, v6Range{start, end, cc})
		}
	}
	// The encoder emits them sorted; sorting again is cheap insurance against a
	// hand-edited table silently breaking the binary search.
	sort.Slice(v4, func(i, j int) bool { return v4[i].start < v4[j].start })
	sort.Slice(v6, func(i, j int) bool { return v6[i].start < v6[j].start })
}

// Country returns the ISO 3166-1 alpha-2 code for an IP, or "" when it is not
// in the table — which includes every private, loopback and link-local address.
// A caller on localhost therefore gets "", not a guess.
func Country(ip net.IP) string {
	if ip == nil || !ip.IsGlobalUnicast() || ip.IsPrivate() {
		return ""
	}
	once.Do(load)

	if v4ip := ip.To4(); v4ip != nil {
		n := uint32(v4ip[0])<<24 | uint32(v4ip[1])<<16 | uint32(v4ip[2])<<8 | uint32(v4ip[3])
		i := sort.Search(len(v4), func(i int) bool { return v4[i].end >= n })
		if i < len(v4) && v4[i].start <= n {
			return v4[i].cc
		}
		return ""
	}

	v16 := ip.To16()
	if v16 == nil {
		return ""
	}
	var hi uint64
	for b := 0; b < 8; b++ {
		hi = hi<<8 | uint64(v16[b])
	}
	i := sort.Search(len(v6), func(i int) bool { return v6[i].end >= hi })
	if i < len(v6) && v6[i].start <= hi {
		return v6[i].cc
	}
	return ""
}

// CountryOf is Country for a string address, ignoring a port if one is present.
func CountryOf(addr string) string {
	addr = strings.TrimSpace(addr)
	if addr == "" {
		return ""
	}
	if host, _, err := net.SplitHostPort(addr); err == nil {
		addr = host
	}
	return Country(net.ParseIP(addr))
}

// Ranges reports how many ranges are loaded, for the health endpoint to prove
// the table is actually in the binary.
func Ranges() (ipv4, ipv6 int) {
	once.Do(load)
	return len(v4), len(v6)
}
