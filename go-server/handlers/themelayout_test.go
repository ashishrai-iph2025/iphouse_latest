package handlers

import (
	"testing"

	ipauth "github.com/ip-house/iphouse-api/auth"
)

func role(n int64) *int64 { return &n }

func TestAcctForKeysStaffAndClientsSeparately(t *testing.T) {
	staff := &ipauth.Claims{LoginID: 7, Role: role(2)}
	if typ, id := acctFor(staff); typ != AcctSuperAdmin || id != 7 {
		t.Errorf("staff got (%q, %d), want (%q, 7)", typ, id, AcctSuperAdmin)
	}

	client := &ipauth.Claims{LoginID: 7, Role: nil}
	if typ, id := acctFor(client); typ != AcctLogin || id != 7 {
		t.Errorf("client got (%q, %d), want (%q, 7)", typ, id, AcctLogin)
	}

	// Same LoginID, different account kind — the two must never collide on
	// one row just because the numbers match. That is the whole reason this
	// table is keyed on (account_type, account_id) and not on LoginID alone.
	st, sid := acctFor(staff)
	ct, cid := acctFor(client)
	if sid == cid && st == ct {
		t.Error("a staff and a client login with the same LoginID resolved to the same account key")
	}
}
