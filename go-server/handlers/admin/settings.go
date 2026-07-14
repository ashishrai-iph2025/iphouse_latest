package admin

import (
	"crypto/rand"
	"encoding/json"
	"log"
	"math/big"
	"net/http"
	"strconv"
	"strings"

	"github.com/ip-house/iphouse-api/activity"
	ipauth "github.com/ip-house/iphouse-api/auth"
	"github.com/ip-house/iphouse-api/db"
	"github.com/ip-house/iphouse-api/email"
	"github.com/ip-house/iphouse-api/markscan"
	"github.com/ip-house/iphouse-api/middleware"
)

// genStrongPassword returns a random n-char password with at least one lower,
// upper, digit and symbol. Ambiguous characters (0/O/1/l/I) are excluded so the
// emailed credential is easy to read and type.
func genStrongPassword(n int) string {
	const (
		lower  = "abcdefghijkmnopqrstuvwxyz"
		upper  = "ABCDEFGHJKLMNPQRSTUVWXYZ"
		digits = "23456789"
		syms   = "!@#$%*?"
	)
	all := lower + upper + digits + syms
	pick := func(set string) byte {
		idx, _ := rand.Int(rand.Reader, big.NewInt(int64(len(set))))
		return set[idx.Int64()]
	}
	if n < 4 {
		n = 4
	}
	b := make([]byte, n)
	b[0], b[1], b[2], b[3] = pick(lower), pick(upper), pick(digits), pick(syms)
	for i := 4; i < n; i++ {
		b[i] = pick(all)
	}
	// Shuffle so the guaranteed classes aren't always in the first four slots.
	for i := len(b) - 1; i > 0; i-- {
		jb, _ := rand.Int(rand.Reader, big.NewInt(int64(i+1)))
		j := int(jb.Int64())
		b[i], b[j] = b[j], b[i]
	}
	return string(b)
}

// logReveal records who revealed which credential, so credential disclosure
// leaves an audit trail in user_activity_log.
func logReveal(r *http.Request, credType, target string) {
	actor := int64(0)
	if c := middleware.GetClaims(r); c != nil {
		actor = c.LoginID
	}
	activity.Log(actor, "credential_reveal", "admin/"+credType+"-credentials",
		activity.GetIP(r), activity.GetUA(r),
		map[string]any{"credential_type": credType, "target": target})
}

// GET/POST/PUT/DELETE /api/admin/email-templates
func EmailTemplates(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		rows, _ := db.Query("SELECT * FROM dcp_email_templates ORDER BY id DESC")
		if rows == nil {
			rows = []map[string]any{}
		}
		ok(w, map[string]any{"success": true, "templates": rows})
	case http.MethodPost:
		var body struct {
			Name        string `json:"name"`
			EventKey    string `json:"event_key"`
			Subject     string `json:"subject"`
			BodyHTML    string `json:"body_html"`
			IsActive    int    `json:"is_active"`
			NotifyEmail string `json:"notify_email"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		if !execOK(w, "the email template",
			"INSERT INTO dcp_email_templates (name, event_key, subject, body_html, is_active, notify_email) VALUES (?, ?, ?, ?, ?, ?)",
			body.Name, body.EventKey, body.Subject, body.BodyHTML, body.IsActive, body.NotifyEmail) {
			return
		}
		ok(w, map[string]any{"success": true})
	case http.MethodPut:
		var body struct {
			ID          int64  `json:"id"`
			Name        string `json:"name"`
			EventKey    string `json:"event_key"`
			Subject     string `json:"subject"`
			BodyHTML    string `json:"body_html"`
			IsActive    int    `json:"is_active"`
			NotifyEmail string `json:"notify_email"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		if !execOK(w, "the email template",
			"UPDATE dcp_email_templates SET name=?, event_key=?, subject=?, body_html=?, is_active=?, notify_email=? WHERE id=?",
			body.Name, body.EventKey, body.Subject, body.BodyHTML, body.IsActive, body.NotifyEmail, body.ID) {
			return
		}
		ok(w, map[string]any{"success": true})
	case http.MethodDelete:
		var body struct {
			ID int64 `json:"id"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		if !execOK(w, "the email template deletion", "DELETE FROM dcp_email_templates WHERE id = ?", body.ID) {
			return
		}
		ok(w, map[string]any{"success": true})
	default:
		fail(w, 405, "Method not allowed")
	}
}

// safeDecryptMain decrypts a value, falling back to the raw string if it
// wasn't encrypted (mirrors the old project's safeDecrypt).
func safeDecryptMain(v any) string {
	s := strVal(v)
	if s == "" {
		return ""
	}
	if dec := ipauth.DecryptMain(s); dec != "" {
		return dec
	}
	return s
}

// GET/POST/PUT/DELETE /api/admin/email-credentials
func EmailCredentials(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		rows, _ := db.Query("SELECT id, email_id, email_password, smtp_host, smtp_port, smtp_secure, purpose, is_active FROM master_email_credentials ORDER BY id DESC")
		if rows == nil {
			rows = []map[string]any{}
		}
		creds := make([]map[string]any, 0, len(rows))
		for _, row := range rows {
			secure := strVal(row["smtp_secure"])
			if secure == "" {
				secure = "tls"
			}
			creds = append(creds, map[string]any{
				"id":            row["id"],
				"emailId":       safeDecryptMain(row["email_id"]),
				"emailPassword": maskSecret(safeDecryptMain(row["email_password"])),
				"smtpHost":      strVal(row["smtp_host"]),
				"smtpPort":      intVal(row["smtp_port"]),
				"smtpSecure":    secure,
				"purpose":       strVal(row["purpose"]),
				"is_active":     row["is_active"],
			})
		}
		ok(w, map[string]any{"success": true, "credentials": creds})
	case http.MethodPost:
		var body struct {
			SMTPHost   string `json:"smtpHost"`
			SMTPPort   int    `json:"smtpPort"`
			SMTPSecure string `json:"smtpSecure"`
			EmailID    string `json:"emailId"`
			EmailPass  string `json:"emailPassword"`
			Purpose    string `json:"purpose"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		if body.EmailID == "" || body.EmailPass == "" || body.SMTPHost == "" || body.SMTPPort == 0 {
			fail(w, 400, "Required fields missing")
			return
		}
		if body.SMTPSecure == "" {
			body.SMTPSecure = "tls"
		}
		if !execOK(w, "the email credentials",
			"INSERT INTO master_email_credentials (email_id, email_password, smtp_host, smtp_port, smtp_secure, purpose, is_active) VALUES (?, ?, ?, ?, ?, ?, 1)",
			ipauth.EncryptMain(body.EmailID), ipauth.EncryptMain(body.EmailPass), body.SMTPHost, body.SMTPPort, body.SMTPSecure, body.Purpose) {
			return
		}
		ok(w, map[string]any{"success": true})
	case http.MethodPut:
		var body struct {
			ID         int64  `json:"id"`
			SMTPHost   string `json:"smtpHost"`
			SMTPPort   int    `json:"smtpPort"`
			SMTPSecure string `json:"smtpSecure"`
			EmailID    string `json:"emailId"`
			EmailPass  string `json:"emailPassword"`
			Purpose    string `json:"purpose"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		if body.ID == 0 || body.EmailID == "" || body.SMTPHost == "" || body.SMTPPort == 0 {
			fail(w, 400, "Required fields missing")
			return
		}
		if body.SMTPSecure == "" {
			body.SMTPSecure = "tls"
		}
		if body.EmailPass != "" {
			if !execOK(w, "the email credentials",
				"UPDATE master_email_credentials SET email_id=?, email_password=?, smtp_host=?, smtp_port=?, smtp_secure=?, purpose=? WHERE id=?",
				ipauth.EncryptMain(body.EmailID), ipauth.EncryptMain(body.EmailPass), body.SMTPHost, body.SMTPPort, body.SMTPSecure, body.Purpose, body.ID) {
				return
			}
		} else {
			if !execOK(w, "the email credentials",
				"UPDATE master_email_credentials SET email_id=?, smtp_host=?, smtp_port=?, smtp_secure=?, purpose=? WHERE id=?",
				ipauth.EncryptMain(body.EmailID), body.SMTPHost, body.SMTPPort, body.SMTPSecure, body.Purpose, body.ID) {
				return
			}
		}
		ok(w, map[string]any{"success": true})
	case http.MethodDelete:
		var body struct {
			ID int64 `json:"id"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		if body.ID == 0 {
			fail(w, 422, "id required")
			return
		}
		if !execOK(w, "the credential deletion", "DELETE FROM master_email_credentials WHERE id = ?", body.ID) {
			return
		}
		ok(w, map[string]any{"success": true})
	default:
		fail(w, 405, "Method not allowed")
	}
}

// GET/POST/PUT/DELETE /api/admin/api-credentials
func APICredentials(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		rows, _ := db.Query(`SELECT userId, name, email, api_user_name, api_password FROM dcp_user WHERE deleted = 0 ORDER BY name`)
		if rows == nil {
			rows = []map[string]any{}
		}
		creds := make([]map[string]any, 0, len(rows))
		for _, row := range rows {
			// Username is shown for display/search; the password is masked so plaintext
			// never reaches the browser. Use the reveal endpoint to fetch it on demand.
			creds = append(creds, map[string]any{
				"userId":        row["userId"],
				"name":          row["name"],
				"email":         row["email"],
				"api_user_name": safeDecryptMain(row["api_user_name"]),
				"api_password":  maskSecret(safeDecryptMain(row["api_password"])),
			})
		}
		ok(w, map[string]any{"success": true, "credentials": creds})
	case http.MethodPut:
		var body struct {
			UserID      int64  `json:"userId"`
			ApiUserName string `json:"apiUserName"`
			ApiPassword string `json:"apiPassword"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		if body.UserID == 0 {
			fail(w, 422, "userId required")
			return
		}
		// An empty password means "keep the current one" — the GET endpoint only ever
		// returns a masked password, so a blank submit must not overwrite the real value.
		var uerr error
		if body.ApiPassword != "" {
			_, _, uerr = db.Exec("UPDATE dcp_user SET api_user_name = ?, api_password = ? WHERE userId = ?",
				ipauth.EncryptMain(body.ApiUserName), ipauth.EncryptMain(body.ApiPassword), body.UserID)
		} else {
			_, _, uerr = db.Exec("UPDATE dcp_user SET api_user_name = ? WHERE userId = ?",
				ipauth.EncryptMain(body.ApiUserName), body.UserID)
		}
		if uerr != nil {
			fail(w, 500, "Save failed: "+uerr.Error()); return
		}
		ok(w, map[string]any{"success": true})
	case http.MethodDelete:
		var body struct {
			UserID int64 `json:"userId"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		if body.UserID == 0 {
			fail(w, 422, "userId required")
			return
		}
		db.Exec("UPDATE dcp_user SET api_user_name = NULL, api_password = NULL WHERE userId = ?", body.UserID)
		ok(w, map[string]any{"success": true})
	default:
		fail(w, 405, "Method not allowed")
	}
}

// GET /api/admin/api-credentials/reveal?userId=<id>
// Returns the decrypted API password for a single client (admin-only, on demand).
func APICredentialsReveal(w http.ResponseWriter, r *http.Request) {
	userID := r.URL.Query().Get("userId")
	if userID == "" {
		fail(w, 422, "userId required"); return
	}
	row, err := db.QueryOne("SELECT userId, api_user_name, api_password FROM dcp_user WHERE userId = ? AND deleted = 0 LIMIT 1", userID)
	if err != nil || row == nil {
		fail(w, 404, "Not found"); return
	}
	logReveal(r, "api", userID)
	ok(w, map[string]any{
		"success":       true,
		"userId":        row["userId"],
		"api_user_name": safeDecryptMain(row["api_user_name"]),
		"api_password":  safeDecryptMain(row["api_password"]),
	})
}

// GET /api/admin/email-credentials/reveal?id=<id>
// Returns the decrypted SMTP password for a single row (admin-only, on demand).
func EmailCredentialsReveal(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Query().Get("id")
	if id == "" {
		fail(w, 422, "id required"); return
	}
	row, err := db.QueryOne("SELECT id, email_id, email_password FROM master_email_credentials WHERE id = ? LIMIT 1", id)
	if err != nil || row == nil {
		fail(w, 404, "Not found"); return
	}
	logReveal(r, "email", id)
	ok(w, map[string]any{
		"success":       true,
		"id":            row["id"],
		"emailId":       safeDecryptMain(row["email_id"]),
		"emailPassword": safeDecryptMain(row["email_password"]),
	})
}

// GET/POST/PUT/DELETE /api/admin/settings
func Settings(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		rows, _ := db.Query("SELECT * FROM dcp_settings ORDER BY id")
		if rows == nil {
			rows = []map[string]any{}
		}
		ok(w, map[string]any{"success": true, "settings": rows})
	case http.MethodPost, http.MethodPut:
		var body struct {
			Key   string `json:"key"`
			Value string `json:"value"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		if !execOK(w, "the setting",
			"INSERT INTO dcp_settings (`key`, `value`) VALUES (?, ?) ON DUPLICATE KEY UPDATE `value` = ?",
			body.Key, body.Value, body.Value) {
			return
		}
		ok(w, map[string]any{"success": true})
	default:
		fail(w, 405, "Method not allowed")
	}
}

func ensureIdleSettingsTable() {
	db.Exec(`CREATE TABLE IF NOT EXISTS user_idle_settings (
		id           INT AUTO_INCREMENT PRIMARY KEY,
		user_id      INT NOT NULL,
		idle_minutes INT NOT NULL DEFAULT 30,
		is_active    TINYINT(1) NOT NULL DEFAULT 1,
		UNIQUE KEY uniq_user (user_id)
	) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
}

// GET/POST/DELETE /api/admin/idle-timeout
func AdminIdleTimeout(w http.ResponseWriter, r *http.Request) {
	ensureIdleSettingsTable()
	switch r.Method {
	case http.MethodGet:
		rows, _ := db.Query(`
			SELECT u.userId, u.name, u.email,
			       s.id AS settingId,
			       COALESCE(s.idle_minutes, 30) AS idle_minutes,
			       COALESCE(s.is_active, 0)     AS is_active
			FROM dcp_user u
			LEFT JOIN user_idle_settings s ON s.user_id = u.userId
			WHERE u.deleted = 0
			ORDER BY u.name ASC`)
		if rows == nil {
			rows = []map[string]any{}
		}
		ok(w, map[string]any{"success": true, "settings": rows})
	case http.MethodPost:
		var body struct {
			UserID      int64 `json:"userId"`
			IdleMinutes int   `json:"idleMinutes"`
			IsActive    int   `json:"isActive"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		if body.UserID == 0 {
			fail(w, 422, "userId required")
			return
		}
		db.Exec(`INSERT INTO user_idle_settings (user_id, idle_minutes, is_active)
			VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE idle_minutes = VALUES(idle_minutes), is_active = VALUES(is_active)`,
			body.UserID, body.IdleMinutes, body.IsActive)
		ok(w, map[string]any{"success": true})
	case http.MethodDelete:
		var body struct {
			SettingID int64 `json:"settingId"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		if body.SettingID == 0 {
			fail(w, 422, "settingId required")
			return
		}
		db.Exec("DELETE FROM user_idle_settings WHERE id = ?", body.SettingID)
		ok(w, map[string]any{"success": true})
	default:
		fail(w, 405, "Method not allowed")
	}
}

// GET/POST /api/admin/asset-access
func AssetAccess(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		users, _ := db.Query(`
			SELECT a.userId, a.loginId,
			       b.name AS clientName, b.api_user_name,
			       CONCAT(IFNULL(a.first_name,''), ' ', IFNULL(a.last_name,'')) AS name,
			       a.login_username AS username, a.is_active
			FROM dcp_user_login a
			LEFT JOIN dcp_user b ON a.userId = b.userId
			WHERE a.is_active = 1
			ORDER BY a.first_name ASC, a.last_name ASC`)
		if users == nil {
			users = []map[string]any{}
		}

		// Bulk fetch asset counts (latest per client_user_id)
		assetCounts := map[int64]int64{}
		if acRows, _ := db.Query(`SELECT client_user_id, JSON_LENGTH(assets) AS asset_count FROM dcp_client_assets WHERE id IN (SELECT MAX(id) FROM dcp_client_assets GROUP BY client_user_id)`); acRows != nil {
			for _, r := range acRows {
				assetCounts[intVal(r["client_user_id"])] = intVal(r["asset_count"])
			}
		}

		// Bulk fetch assigned info (keyed by login_id)
		type assignedInfo struct {
			count   int64
			preview string
		}
		assignedMap := map[int64]assignedInfo{}
		if asRows, _ := db.Query(`SELECT login_id, assigned_count, assigned_assets FROM dcp_assigned_assets`); asRows != nil {
			for _, r := range asRows {
				assignedMap[intVal(r["login_id"])] = assignedInfo{
					count:   intVal(r["assigned_count"]),
					preview: strVal(r["assigned_assets"]),
				}
			}
		}

		enriched := make([]map[string]any, 0, len(users))
		for _, u := range users {
			uid := intVal(u["userId"])
			lid := intVal(u["loginId"])
			totalAssets := assetCounts[uid]
			ai := assignedMap[lid]
			previewSrc := ai.preview
			if previewSrc == "" {
				previewSrc = "[]"
			}
			var previewArr []map[string]any
			if err := json.Unmarshal([]byte(previewSrc), &previewArr); err != nil || previewArr == nil {
				previewArr = []map[string]any{}
			}
			if len(previewArr) > 3 {
				previewArr = previewArr[:3]
			}
			enriched = append(enriched, map[string]any{
				"userId":           uid,
				"loginId":          lid,
				"clientName":       strVal(u["clientName"]),
				"apiUserName":      strVal(u["api_user_name"]),
				"name":             strings.TrimSpace(strVal(u["name"])),
				"username":         strVal(u["username"]),
				"is_active":        u["is_active"],
				"total_assets":     totalAssets,
				"assigned_count":   ai.count,
				"assigned_preview": previewArr,
			})
		}
		ok(w, map[string]any{"success": true, "items": enriched})
	case http.MethodPost:
		var body struct {
			Action       string           `json:"action"`
			ClientUserID int64            `json:"clientUserId"`
			LoginID      int64            `json:"loginId"`
			Assets       []map[string]any `json:"assets"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		switch body.Action {
		case "login_client":
			if body.ClientUserID == 0 {
				ok(w, map[string]any{"success": false, "message": "clientUserId required"})
				return
			}
			user, _ := db.QueryOne("SELECT name, api_user_name, api_password FROM dcp_user WHERE userId = ? AND deleted = 0", body.ClientUserID)
			if user == nil || strVal(user["api_user_name"]) == "" || strVal(user["api_password"]) == "" {
				ok(w, map[string]any{"success": false, "message": "No API credentials configured for this client"})
				return
			}
			token, err := markscan.Login(strVal(user["api_user_name"]), strVal(user["api_password"]))
			if err != nil || token == "" {
				ok(w, map[string]any{"success": false, "message": "API login failed — check the client's API credentials"})
				return
			}
			rawAssets, err := markscan.GetAllAssets(token)
			if err != nil || len(rawAssets) == 0 {
				ok(w, map[string]any{"success": false, "message": "No assets returned from API"})
				return
			}
			assets := make([]map[string]any, 0, len(rawAssets))
			for i, a := range rawAssets {
				id := ""
				name := ""
				switch v := a.(type) {
				case string:
					name = v
				case map[string]any:
					for _, k := range []string{"Id", "id", "ID", "assetId"} {
						if s := strVal(v[k]); s != "" {
							id = s
							break
						}
					}
					for _, k := range []string{"AssetName", "assetName", "Name", "name", "Asset"} {
						if s := strVal(v[k]); s != "" {
							name = s
							break
						}
					}
				}
				if id == "" {
					id = strconv.Itoa(i + 1)
				}
				assets = append(assets, map[string]any{"id": id, "name": name})
			}
			db.Exec("DELETE FROM dcp_client_assets WHERE client_user_id = ?", body.ClientUserID)
			assetsJSON, _ := json.Marshal(assets)
			db.Exec("INSERT INTO dcp_client_assets (client_user_id, client_name, api_token, assets, created_at) VALUES (?, ?, ?, ?, NOW())",
				body.ClientUserID, strVal(user["name"]), token, string(assetsJSON))
			ok(w, map[string]any{"success": true, "assets_count": len(assets)})
		case "get_assets":
			row, _ := db.QueryOne("SELECT client_name, assets FROM dcp_client_assets WHERE client_user_id = ? ORDER BY created_at DESC LIMIT 1", body.ClientUserID)
			if row == nil {
				ok(w, map[string]any{"success": false, "message": "No assets found. Use Fetch first."})
				return
			}
			var assets []map[string]any
			json.Unmarshal([]byte(strVal(row["assets"])), &assets)
			if assets == nil {
				assets = []map[string]any{}
			}
			assignedRow, _ := db.QueryOne("SELECT assigned_assets FROM dcp_assigned_assets WHERE login_id = ? LIMIT 1", body.LoginID)
			var assignedObjs []map[string]any
			if assignedRow != nil {
				json.Unmarshal([]byte(strVal(assignedRow["assigned_assets"])), &assignedObjs)
			}
			if assignedObjs == nil {
				assignedObjs = []map[string]any{}
			}
			assignedIds := make([]string, 0, len(assignedObjs))
			for _, a := range assignedObjs {
				if id := strVal(a["id"]); id != "" {
					assignedIds = append(assignedIds, id)
				}
			}
			ok(w, map[string]any{"success": true, "data": map[string]any{"assets": assets, "assignedIds": assignedIds, "assets_count": len(assets)}})
		case "assign_assets":
			assetsJSON, _ := json.Marshal(body.Assets)
			client, _ := db.QueryOne("SELECT name FROM dcp_user WHERE userId = ? LIMIT 1", body.ClientUserID)
			clientName := ""
			if client != nil {
				clientName = strVal(client["name"])
			}
			db.Exec(`INSERT INTO dcp_assigned_assets (login_id, client_user_id, client_name, assigned_assets, assigned_count)
				VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE assigned_assets=VALUES(assigned_assets), assigned_count=VALUES(assigned_count), assigned_at=CURRENT_TIMESTAMP`,
				body.LoginID, body.ClientUserID, clientName, string(assetsJSON), len(body.Assets))
			ok(w, map[string]any{"success": true, "count": len(body.Assets)})
		case "delete_access":
			db.Exec("DELETE FROM dcp_assigned_assets WHERE login_id = ?", body.LoginID)
			ok(w, map[string]any{"success": true})
		default:
			fail(w, 422, "Unknown action")
		}
	default:
		fail(w, 405, "Method not allowed")
	}
}

// GET/POST/PUT/DELETE /api/admin/master-api
func MasterAPI(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		rows, _ := db.Query("SELECT * FROM dcp_master_api ORDER BY id DESC")
		if rows == nil {
			rows = []map[string]any{}
		}
		ok(w, map[string]any{"success": true, "items": rows})
	case http.MethodPost, http.MethodPut:
		var body any
		json.NewDecoder(r.Body).Decode(&body)
		ok(w, map[string]any{"success": true})
	default:
		fail(w, 405, "Method not allowed")
	}
}

// GET /api/admin/activity-stats
func ActivityStats(w http.ResponseWriter, r *http.Request) {
	rows, _ := db.Query("SELECT user_id, action, page_url, ip_address, created_at FROM user_activity_log ORDER BY created_at DESC LIMIT 200")
	if rows == nil {
		rows = []map[string]any{}
	}
	ok(w, map[string]any{"success": true, "items": rows})
}

// GET /api/admin/tracking
func Tracking(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	limit := 20
	if n, _ := strconv.Atoi(q.Get("limit")); n > 0 && n <= 500 {
		limit = n
	}
	offset := 0
	if n, _ := strconv.Atoi(q.Get("offset")); n >= 0 {
		offset = n
	}
	action := q.Get("action")
	search := q.Get("search")
	from := q.Get("from")
	to := q.Get("to")
	userID := q.Get("userId")

	conds := []string{}
	args := []any{}
	if action != "" {
		conds = append(conds, "l.action = ?")
		args = append(args, action)
	}
	if userID != "" {
		conds = append(conds, "l.user_id = ?")
		args = append(args, userID)
	}
	if from != "" {
		conds = append(conds, "l.created_at >= ?")
		args = append(args, from)
	}
	if to != "" {
		conds = append(conds, "l.created_at <= ?")
		args = append(args, to+" 23:59:59")
	}
	if search != "" {
		conds = append(conds, "(l.ip_address LIKE ? OR ul.login_username LIKE ? OR ul.first_name LIKE ? OR ul.last_name LIKE ? OR u.name LIKE ? OR u.email LIKE ?)")
		args = append(args, "%"+search+"%", "%"+search+"%", "%"+search+"%", "%"+search+"%", "%"+search+"%", "%"+search+"%")
	}
	where := ""
	if len(conds) > 0 {
		where = "WHERE " + strings.Join(conds, " AND ")
	}

	// user_id in the log may be a dcp_user.userId (client dashboard views) or a
	// dcp_user_login.loginId (admin/portal actions) — join both and resolve.
	join := `FROM user_activity_log l
		LEFT JOIN dcp_user u ON u.userId = l.user_id
		LEFT JOIN dcp_user_login ul ON ul.loginId = l.user_id`

	countArgs := make([]any, len(args))
	copy(countArgs, args)
	countRow, _ := db.QueryOne("SELECT COUNT(*) AS total "+join+" "+where, countArgs...)
	total := int64(0)
	if countRow != nil {
		total = intVal(countRow["total"])
	}

	queryArgs := append(args, limit, offset)
	logs, _ := db.Query(`
		SELECT l.id, l.user_id,
		       COALESCE(
		           NULLIF(TRIM(CONCAT(COALESCE(ul.first_name,''),' ',COALESCE(ul.last_name,''))), ''),
		           u.name,
		           ul.login_username,
		           CONCAT('UID ', l.user_id)
		       ) AS full_name,
		       COALESCE(NULLIF(u.email, ''), ul.login_username, '') AS email,
		       COALESCE(ul.login_username, u.email, CONCAT('uid:', l.user_id)) AS username,
		       l.page_url, l.action, l.ip_address, l.user_agent,
		       DATE_FORMAT(l.created_at, '%Y-%m-%d %H:%i:%s') AS created_at
		`+join+` `+where+`
		ORDER BY l.created_at DESC LIMIT ? OFFSET ?`, queryArgs...)
	if logs == nil {
		logs = []map[string]any{}
	}
	ok(w, map[string]any{"success": true, "logs": logs, "total": total})
}

// GET /api/admin/tracking/analytics
func TrackingAnalytics(w http.ResponseWriter, r *http.Request) {
	safe := func(rows []map[string]any) []map[string]any {
		if rows == nil {
			return []map[string]any{}
		}
		return rows
	}
	actionCounts, _ := db.Query("SELECT action, COUNT(*) AS count FROM user_activity_log GROUP BY action ORDER BY count DESC")
	dailyTrend, _ := db.Query("SELECT DATE(created_at) AS date, COUNT(*) AS count FROM user_activity_log WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL 30 DAY) GROUP BY DATE(created_at) ORDER BY date ASC")
	topPages, _ := db.Query("SELECT page_url, COUNT(*) AS count FROM user_activity_log GROUP BY page_url ORDER BY count DESC LIMIT 10")
	topUsers, _ := db.Query(`SELECT COALESCE(ul.login_username, u.email, CONCAT('uid_', l.user_id)) AS username, COUNT(*) AS count, MAX(DATE_FORMAT(l.created_at, '%Y-%m-%d %H:%i')) AS last_seen FROM user_activity_log l LEFT JOIN dcp_user_login ul ON ul.loginId = l.user_id LEFT JOIN dcp_user u ON u.userId = l.user_id GROUP BY l.user_id ORDER BY count DESC LIMIT 10`)
	dashboardAccess, _ := db.Query("SELECT dashboard_name AS title, COUNT(*) AS count FROM user_dashboard_access GROUP BY report_id ORDER BY count DESC LIMIT 10")
	hourlyDist, _ := db.Query("SELECT HOUR(created_at) AS hour, COUNT(*) AS count FROM user_activity_log GROUP BY HOUR(created_at) ORDER BY hour ASC")
	ok(w, map[string]any{
		"success":         true,
		"actionCounts":    safe(actionCounts),
		"dailyTrend":      safe(dailyTrend),
		"topPages":        safe(topPages),
		"topUsers":        safe(topUsers),
		"dashboardAccess": safe(dashboardAccess),
		"hourlyDist":      safe(hourlyDist),
	})
}

// GET /api/admin/home-analytics
func HomeAnalytics(w http.ResponseWriter, r *http.Request) {
	safe := func(rows []map[string]any) []map[string]any {
		if rows == nil {
			return []map[string]any{}
		}
		return rows
	}
	cnt := func(row map[string]any) int64 {
		if row == nil {
			return 0
		}
		return intVal(row["cnt"])
	}

	// KPI counts
	totalClients, _ := db.QueryOne("SELECT COUNT(*) AS cnt FROM dcp_user WHERE (role IS NULL OR role < 1) AND deleted = 0")
	clientAccounts, _ := db.QueryOne("SELECT COUNT(*) AS cnt FROM dcp_user_login l INNER JOIN dcp_user u ON u.userId = l.userId WHERE l.is_active = 1 AND u.deleted = 0 AND (u.role IS NULL OR u.role < 1)")
	admins, _ := db.QueryOne("SELECT COUNT(*) AS cnt FROM dcp_user WHERE role = 1 AND deleted = 0")
	superAdmins, _ := db.QueryOne("SELECT COUNT(*) AS cnt FROM dcp_user WHERE role = 2 AND deleted = 0")
	totalLogins, _ := db.QueryOne("SELECT COUNT(*) AS cnt FROM dcp_user_login WHERE is_active = 1")
	activeLogins, _ := db.QueryOne("SELECT COUNT(*) AS cnt FROM dcp_user_login l INNER JOIN dcp_user u ON u.userId = l.userId WHERE l.is_active = 1 AND u.deleted = 0")
	loginsThisWeek, _ := db.QueryOne("SELECT COUNT(*) AS cnt FROM dcp_login WHERE loginTime >= DATE_SUB(NOW(), INTERVAL 7 DAY)")
	loginsThisMonth, _ := db.QueryOne("SELECT COUNT(*) AS cnt FROM dcp_login WHERE loginTime >= DATE_SUB(NOW(), INTERVAL 30 DAY)")

	counts := map[string]any{
		"totalClients":    cnt(totalClients),
		"clientAccounts":  cnt(clientAccounts),
		"admins":          cnt(admins),
		"superAdmins":     cnt(superAdmins),
		"totalLogins":     cnt(totalLogins),
		"activeLogins":    cnt(activeLogins),
		"loginsThisWeek":  cnt(loginsThisWeek),
		"loginsThisMonth": cnt(loginsThisMonth),
	}

	// Weekly logins (last 14 days)
	weeklyLogins, _ := db.Query("SELECT DATE(loginTime) AS date, COUNT(*) AS count FROM dcp_login WHERE loginTime >= DATE_SUB(NOW(), INTERVAL 14 DAY) GROUP BY DATE(loginTime) ORDER BY date ASC")

	// Monthly logins (last 12 months)
	monthlyLogins, _ := db.Query("SELECT DATE_FORMAT(loginTime, '%Y-%m') AS month, COUNT(*) AS count FROM dcp_login WHERE loginTime >= DATE_SUB(NOW(), INTERVAL 12 MONTH) GROUP BY month ORDER BY month ASC")

	// Top users by total portal activity (sourced from the activity log, which is
	// always populated — dcp_login may be empty/absent). user_id may be a userId or loginId.
	topClients, _ := db.Query(`
		SELECT l.user_id AS loginId,
		       COALESCE(NULLIF(u.name,''), ul.login_username, CONCAT('UID ', l.user_id)) AS name,
		       COALESCE(ul.login_username, u.email, CONCAT('uid:', l.user_id)) AS username,
		       COUNT(*) AS total_logins,
		       MAX(DATE_FORMAT(l.created_at, '%Y-%m-%d %H:%i')) AS last_login,
		       COALESCE(MAX(ul.is_active), 1) AS is_active
		FROM user_activity_log l
		LEFT JOIN dcp_user u ON u.userId = l.user_id
		LEFT JOIN dcp_user_login ul ON ul.loginId = l.user_id
		GROUP BY l.user_id
		ORDER BY total_logins DESC LIMIT 20`)

	// Top login users — ranked by login events in the activity log.
	topLoginUsers, _ := db.Query(`
		SELECT l.user_id AS loginId,
		       COALESCE(
		           NULLIF(TRIM(CONCAT(COALESCE(ul.first_name,''),' ',COALESCE(ul.last_name,''))), ''),
		           u.name, ul.login_username, CONCAT('UID ', l.user_id)
		       ) AS name,
		       COALESCE(ul.login_username, u.email, CONCAT('uid:', l.user_id)) AS username,
		       COALESCE(u.name, '') AS client,
		       COALESCE(ul.login_type, 0) AS login_type,
		       COUNT(*) AS logins,
		       MAX(DATE_FORMAT(l.created_at, '%Y-%m-%d %H:%i')) AS last_login,
		       COALESCE(ul.is_active, 1) AS is_active
		FROM user_activity_log l
		LEFT JOIN dcp_user u ON u.userId = l.user_id
		LEFT JOIN dcp_user_login ul ON ul.loginId = l.user_id
		WHERE l.action = 'login'
		GROUP BY l.user_id
		ORDER BY logins DESC LIMIT 20`)

	// Module usage
	moduleUsage, _ := db.Query(`SELECT md.moduleName, COUNT(mp.userId) AS users, SUM(mp.active) AS active FROM dcp_module md LEFT JOIN dcp_user_module_map mp ON mp.moduleId = md.moduleId AND mp.active = 1 WHERE md.deleted = 0 GROUP BY md.moduleId ORDER BY users DESC`)

	// Recent logins — sourced from the activity log (action='login'), which is
	// always populated; dcp_login may be empty. user_id may be a userId or loginId.
	recentLogins, _ := db.Query(`
		SELECT l.id AS loginId,
		       COALESCE(u.name, ul.login_username, CONCAT('UID ', l.user_id)) AS client,
		       COALESCE(ul.login_username, u.email, CONCAT('uid:', l.user_id)) AS username,
		       DATE_FORMAT(l.created_at, '%Y-%m-%d %H:%i:%s') AS loginTime
		FROM user_activity_log l
		LEFT JOIN dcp_user u ON u.userId = l.user_id
		LEFT JOIN dcp_user_login ul ON ul.loginId = l.user_id
		WHERE l.action = 'login'
		ORDER BY l.created_at DESC LIMIT 15`)

	// Registration trend (last 30 days)
	registrationTrend, _ := db.Query("SELECT DATE(created_at) AS date, COUNT(*) AS count FROM user_registration_requests WHERE created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY) AND status = 'approved' GROUP BY DATE(created_at) ORDER BY date ASC")

	// PowerBI dashboard views — from user_dashboard_access (logged by the embed-token handler)
	dashboardAccess, _ := db.Query("SELECT COALESCE(NULLIF(dashboard_name,''), CONCAT('Report ', report_id)) AS title, COUNT(*) AS count FROM user_dashboard_access GROUP BY report_id ORDER BY count DESC LIMIT 10")

	// Who viewed which dashboard, most recent first
	recentDashboardViews, _ := db.Query(`
		SELECT a.id,
		       COALESCE(u.name, ul.login_username, CONCAT('UID ', a.user_id)) AS client,
		       COALESCE(ul.login_username, u.email, '') AS username,
		       COALESCE(NULLIF(a.dashboard_name,''), CONCAT('Report ', a.report_id)) AS report,
		       DATE_FORMAT(a.accessed_at, '%Y-%m-%d %H:%i:%s') AS viewedAt
		FROM user_dashboard_access a
		LEFT JOIN dcp_user u ON u.userId = a.user_id
		LEFT JOIN dcp_user_login ul ON ul.loginId = a.login_id
		ORDER BY a.accessed_at DESC LIMIT 15`)

	// Login type breakdown
	loginTypeBreakdown, _ := db.Query(`SELECT CASE login_type WHEN 0 THEN 'Email OTP' WHEN 1 THEN 'Authenticator' ELSE 'Password' END AS label, COUNT(*) AS count FROM dcp_user_login WHERE is_active = 1 GROUP BY login_type`)

	// Active vs inactive logins
	activeVsInactive, _ := db.Query(`SELECT CASE WHEN l.is_active = 1 AND u.deleted = 0 THEN 'Active' ELSE 'Inactive' END AS status, COUNT(*) AS count FROM dcp_user_login l INNER JOIN dcp_user u ON u.userId = l.userId GROUP BY status`)

	// Clients with most users
	clientsWithMostUsers, _ := db.Query(`SELECT u.name, COUNT(l.loginId) AS count FROM dcp_user_login l INNER JOIN dcp_user u ON u.userId = l.userId WHERE l.is_active = 1 AND u.deleted = 0 GROUP BY u.userId ORDER BY count DESC LIMIT 10`)

	ok(w, map[string]any{
		"success":              true,
		"counts":               counts,
		"weeklyLogins":         safe(weeklyLogins),
		"monthlyLogins":        safe(monthlyLogins),
		"topClients":           safe(topClients),
		"topLoginUsers":        safe(topLoginUsers),
		"moduleUsage":          safe(moduleUsage),
		"recentLogins":         safe(recentLogins),
		"recentDashboardViews": safe(recentDashboardViews),
		"registrationTrend":    safe(registrationTrend),
		"dashboardAccess":      safe(dashboardAccess),
		"loginTypeBreakdown":   safe(loginTypeBreakdown),
		"activeVsInactive":     safe(activeVsInactive),
		"clientsWithMostUsers": safe(clientsWithMostUsers),
	})
}

// GET/PUT /api/admin/registrations
func Registrations(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		rows, _ := db.Query("SELECT * FROM user_registration_requests ORDER BY created_at DESC")
		if rows == nil {
			rows = []map[string]any{}
		}
		ok(w, map[string]any{"success": true, "requests": rows})
	case http.MethodPut:
		registrationsUpdate(w, r)
	default:
		fail(w, 405, "Method not allowed")
	}
}

func registrationsUpdate(w http.ResponseWriter, r *http.Request) {
	var body struct {
		RequestID int64  `json:"requestId"`
		Action    string `json:"action"`
		Reason    string `json:"reason"`
	}
	json.NewDecoder(r.Body).Decode(&body)
	if body.RequestID == 0 || body.Action == "" {
		fail(w, 422, "requestId and action required")
		return
	}

	// Accept both "reject"/"rejected" and "approve"/"approved" so the payload
	// matches whether the caller sends the verb or the resulting status.
	if body.Action == "reject" || body.Action == "rejected" {
		db.Exec("UPDATE user_registration_requests SET status='rejected' WHERE id=?", body.RequestID)
		req, _ := db.QueryOne("SELECT * FROM user_registration_requests WHERE id = ?", body.RequestID)
		if req != nil {
			emailAddr := strVal(req["email"])
			name := strVal(req["first_name"]) + " " + strVal(req["last_name"])
			go email.SendRegistrationRejected(emailAddr, name, body.Reason)
		}
		ok(w, map[string]any{"success": true})
		return
	}

	if body.Action == "approve" || body.Action == "approved" {
		req, _ := db.QueryOne("SELECT * FROM user_registration_requests WHERE id = ? AND status = 'pending'", body.RequestID)
		if req == nil {
			ok(w, map[string]any{"success": false, "error": "Request not found or already processed"})
			return
		}

		fullName := strVal(req["first_name"]) + " " + strVal(req["last_name"])
		emailAddr := strVal(req["email"])
		rawPass, _ := req["password_raw"].(string)
		if rawPass == "" {
			rawPass = genStrongPassword(12)
		}

		// Approval creates only the person's login credential — no dcp_user
		// (client company) row. The login stays unassigned (userId NULL) and
		// cannot sign in until an admin attaches client companies to it from
		// /admin/registrations (shared logins), since every login path joins
		// dcp_user_login to dcp_user.
		hashed, _ := ipAuthHashPassword(rawPass)
		username := strVal(req["username"])
		if username == "" {
			username = emailAddr
		}
		if dup, _ := db.QueryOne("SELECT loginId FROM dcp_user_login WHERE login_username = ? AND is_active = 1 LIMIT 1", username); dup != nil {
			ok(w, map[string]any{"success": false, "error": "A login with this username already exists"})
			return
		}
		lid, _, err := db.Exec("INSERT INTO dcp_user_login (userId, first_name, last_name, designation, login_username, login_password, login_type, is_active) VALUES (NULL, ?, ?, ?, ?, ?, 0, 1)",
			strVal(req["first_name"]), strVal(req["last_name"]), nullStr(strVal(req["designation"])), username, hashed)
		if err != nil {
			fail(w, 500, err.Error())
			return
		}
		db.Exec("UPDATE user_registration_requests SET status='approved' WHERE id=?", body.RequestID)

		go email.SendRegistrationApproved(emailAddr, fullName, username, rawPass, "/login")

		ok(w, map[string]any{"success": true, "loginId": lid})
		return
	}

	fail(w, 422, "Unknown action")
}

func ipAuthHashPassword(plain string) (string, error) {
	return ipauth.HashPassword(plain)
}

var _ = ipauth.HashPassword // ensure import used

// GET /api/admin/registration-requests
func RegistrationRequests(w http.ResponseWriter, r *http.Request) {
	rows, _ := db.Query("SELECT * FROM user_registration_requests ORDER BY created_at DESC")
	if rows == nil {
		rows = []map[string]any{}
	}
	ok(w, map[string]any{"success": true, "requests": rows})
}

// GET /api/admin/shared-logins
// GET/POST /api/admin/shared-logins
func SharedLogins(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		// portal_role reflects the PERSON behind this shared login (one row in
		// dcp_super_admin keyed by login_username/email), independent of any of
		// the client companies they happen to be assigned to view.
		logins, err := db.Query(`
			SELECT
				MAX(ul.loginId)                                              AS loginId,
				ul.login_username,
				MAX(ul.login_type)                                           AS login_type,
				MAX(ul.twofa_secret)                                         AS twofa_secret,
				MAX(ul.first_name)                                           AS first_name,
				MAX(ul.last_name)                                            AS last_name,
				MAX(ul.designation)                                          AS designation,
				GROUP_CONCAT(DISTINCT ul.userId)                             AS allUserIds,
				GROUP_CONCAT(DISTINCT u.name ORDER BY u.name SEPARATOR ', ') AS master_names,
				MAX(sa.role)                                                 AS portal_role
			FROM dcp_user_login ul
			LEFT JOIN dcp_user u ON u.userId = ul.userId AND u.deleted = 0
			LEFT JOIN dcp_super_admin sa
				ON CONVERT(sa.email USING utf8mb4) COLLATE utf8mb4_general_ci
				 = CONVERT(ul.login_username USING utf8mb4) COLLATE utf8mb4_general_ci
				AND sa.is_active = 1
			WHERE ul.is_active = 1
			GROUP BY ul.login_username
			ORDER BY loginId DESC`)
		if err != nil {
			log.Printf("[shared-logins] query failed: %v", err)
		}
		if logins == nil {
			logins = []map[string]any{}
		}
		// twofa_secret is encrypted at rest; decrypt for the editor. safeDecryptMain
		// returns legacy plaintext values unchanged, so pre-encryption rows still work.
		for _, l := range logins {
			if l["twofa_secret"] != nil {
				l["twofa_secret"] = safeDecryptMain(l["twofa_secret"])
			}
		}

		masterUsers, _ := db.Query("SELECT userId, name FROM dcp_user WHERE deleted = 0 ORDER BY name")
		if masterUsers == nil {
			masterUsers = []map[string]any{}
		}

		ok(w, map[string]any{"success": true, "logins": logins, "masterUsers": masterUsers})

	case http.MethodPost:
		var body struct {
			Action        string  `json:"action"`
			LoginUsername string  `json:"login_username"`
			LoginPassword string  `json:"login_password"`
			LoginType     int     `json:"login_type"`
			TwofaSecret   string  `json:"twofa_secret"`
			FirstName     string  `json:"first_name"`
			LastName      string  `json:"last_name"`
			Designation   string  `json:"designation"`
			UserIDs       []int64 `json:"userIds"`
		}
		json.NewDecoder(r.Body).Decode(&body)

		switch body.Action {
		case "add":
			if body.LoginUsername == "" || len(body.UserIDs) == 0 {
				fail(w, 422, "Username and at least one user required")
				return
			}
			hashed := ""
			if body.LoginPassword != "" {
				h, err := ipauth.HashPassword(body.LoginPassword)
				if err != nil {
					fail(w, 500, err.Error())
					return
				}
				hashed = h
			}
			for _, uid := range body.UserIDs {
				db.Exec(`INSERT INTO dcp_user_login (userId, login_username, login_password, login_type, twofa_secret, first_name, last_name, designation, is_active) VALUES (?,?,?,?,?,?,?,?,1)`,
					uid, body.LoginUsername, hashed, body.LoginType,
					encNullStr(body.TwofaSecret), nullStr(body.FirstName), nullStr(body.LastName), nullStr(body.Designation))
			}
			ok(w, map[string]any{"success": true})

		case "update":
			if body.LoginUsername == "" || len(body.UserIDs) == 0 {
				fail(w, 422, "Username and at least one user required")
				return
			}
			// Resolve password: use new hash or keep existing
			hashed := ""
			if body.LoginPassword != "" {
				h, err := ipauth.HashPassword(body.LoginPassword)
				if err != nil {
					fail(w, 500, err.Error())
					return
				}
				hashed = h
			} else {
				row, _ := db.QueryOne("SELECT login_password FROM dcp_user_login WHERE login_username = ? AND is_active = 1 LIMIT 1", body.LoginUsername)
				if row != nil {
					hashed = strVal(row["login_password"])
				}
			}
			// Update credentials on existing rows
			db.Exec(`UPDATE dcp_user_login SET login_password=?, login_type=?, twofa_secret=?, first_name=?, last_name=?, designation=? WHERE login_username=? AND is_active=1`,
				hashed, body.LoginType, encNullStr(body.TwofaSecret), nullStr(body.FirstName), nullStr(body.LastName), nullStr(body.Designation), body.LoginUsername)
			// Get current user IDs
			currentRows, _ := db.Query("SELECT userId FROM dcp_user_login WHERE login_username = ? AND is_active = 1", body.LoginUsername)
			currentMap := map[int64]bool{}
			for _, r := range currentRows {
				currentMap[intVal(r["userId"])] = true
			}
			newMap := map[int64]bool{}
			for _, id := range body.UserIDs {
				newMap[id] = true
			}
			// Insert new users
			for _, uid := range body.UserIDs {
				if !currentMap[uid] {
					db.Exec(`INSERT INTO dcp_user_login (userId, login_username, login_password, login_type, twofa_secret, first_name, last_name, designation, is_active) VALUES (?,?,?,?,?,?,?,?,1)`,
						uid, body.LoginUsername, hashed, body.LoginType,
						encNullStr(body.TwofaSecret), nullStr(body.FirstName), nullStr(body.LastName), nullStr(body.Designation))
				}
			}
			// Soft-delete removed users. uid 0 is an unassigned placeholder row
			// (userId NULL, created by registration approval) — retire it now
			// that real company assignments exist.
			for _, r := range currentRows {
				uid := intVal(r["userId"])
				if uid == 0 {
					db.Exec("UPDATE dcp_user_login SET is_active = 0 WHERE login_username = ? AND userId IS NULL", body.LoginUsername)
					continue
				}
				if !newMap[uid] {
					db.Exec("UPDATE dcp_user_login SET is_active = 0 WHERE login_username = ? AND userId = ?", body.LoginUsername, uid)
				}
			}
			ok(w, map[string]any{"success": true})

		case "delete":
			if body.LoginUsername == "" {
				fail(w, 422, "login_username required")
				return
			}
			db.Exec("UPDATE dcp_user_login SET is_active = 0 WHERE login_username = ?", body.LoginUsername)
			ok(w, map[string]any{"success": true})

		default:
			fail(w, 422, "Unknown action")
		}

	default:
		fail(w, 405, "Method not allowed")
	}
}

func nullStr(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// encNullStr encrypts a non-empty secret with the main key for storage, or
// returns nil (SQL NULL) when empty. Used for the 2FA authenticator seed.
func encNullStr(s string) any {
	if s == "" {
		return nil
	}
	return ipauth.EncryptMain(s)
}

// GET/POST/PUT/DELETE /api/admin/email-event-types
func EmailEventTypes(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		rows, _ := db.Query("SELECT * FROM dcp_email_event_types ORDER BY sort_order ASC, id ASC")
		if rows == nil {
			rows = []map[string]any{}
		}
		ok(w, map[string]any{"success": true, "eventTypes": rows})
	case http.MethodPost:
		var body struct {
			Key         string `json:"key"`
			Label       string `json:"label"`
			Description string `json:"description"`
			HasNotifyEmail int `json:"has_notify_email"`
			Variables   string `json:"variables"`
			SortOrder   int    `json:"sort_order"`
			IsActive    int    `json:"is_active"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		if body.Key == "" || body.Label == "" {
			fail(w, 400, "key and label are required")
			return
		}
		_, _, err := db.Exec(
			"INSERT INTO dcp_email_event_types (`key`, label, description, has_notify_email, variables, sort_order, is_active) VALUES (?, ?, ?, ?, ?, ?, ?)",
			body.Key, body.Label, body.Description, body.HasNotifyEmail, body.Variables, body.SortOrder, body.IsActive,
		)
		if err != nil {
			fail(w, 409, "Event key already exists or invalid data")
			return
		}
		ok(w, map[string]any{"success": true})
	case http.MethodPut:
		var body struct {
			ID          int64  `json:"id"`
			Key         string `json:"key"`
			Label       string `json:"label"`
			Description string `json:"description"`
			HasNotifyEmail int `json:"has_notify_email"`
			Variables   string `json:"variables"`
			SortOrder   int    `json:"sort_order"`
			IsActive    int    `json:"is_active"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		if body.ID == 0 {
			fail(w, 422, "id required")
			return
		}
		db.Exec(
			"UPDATE dcp_email_event_types SET `key`=?, label=?, description=?, has_notify_email=?, variables=?, sort_order=?, is_active=? WHERE id=?",
			body.Key, body.Label, body.Description, body.HasNotifyEmail, body.Variables, body.SortOrder, body.IsActive, body.ID,
		)
		ok(w, map[string]any{"success": true})
	case http.MethodDelete:
		var body struct {
			ID int64 `json:"id"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		if body.ID == 0 {
			fail(w, 422, "id required")
			return
		}
		db.Exec("DELETE FROM dcp_email_event_types WHERE id = ?", body.ID)
		ok(w, map[string]any{"success": true})
	default:
		fail(w, 405, "Method not allowed")
	}
}
