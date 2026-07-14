package handlers

import (
	"encoding/json"
	"net/http"

	"github.com/ip-house/iphouse-api/db"
)

// POST /api/admin/staff-otp — Super Admin toggles OTP login for ONE staff
// account. Body: { id: <dcp_super_admin.id>, enabled: bool }.
//
// OTP login is per staff member (stored on dcp_super_admin.otp_login_enabled),
// not a single platform-wide switch, so each Admin/Super Admin can be required
// to use it independently.
func StaffOTPSetting(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		Fail(w, 405, "Method not allowed"); return
	}
	var body struct {
		ID      int64 `json:"id"`
		Enabled bool  `json:"enabled"`
	}
	json.NewDecoder(r.Body).Decode(&body)
	if body.ID == 0 {
		Fail(w, 422, "id is required"); return
	}
	val := 0
	if body.Enabled {
		val = 1
	}
	if err := db.MustExec("UPDATE dcp_super_admin SET otp_login_enabled = ? WHERE id = ?", val, body.ID); err != nil {
		Fail(w, 500, "Could not update the OTP login setting"); return
	}
	OK(w, map[string]any{"success": true, "id": body.ID, "enabled": body.Enabled})
}
